package cmd

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/spf13/cobra"

	"github.com/yingyeothon/service/cli/internal/api"
)

// The console's limits on one call (services/console/src/assets.ts): 100
// files per presign or commit, 1,000 paths per delete or stale mark, and a
// 64 KiB request body, which a thousand long paths would exceed.
const (
	assetBatchMax = 100
	assetPathsMax = 1000
	assetBodyMax  = 60 << 10
)

// chunkBySize splits items into runs of at most maxCount whose JSON array
// stays under maxBytes (each item costs its encoding plus a comma).
func chunkBySize(items []string, maxCount, maxBytes int) [][]string {
	var out [][]string
	var cur []string
	size := 0
	for _, it := range items {
		b, _ := json.Marshal(it)
		n := len(b) + 1
		if len(cur) > 0 && (len(cur) == maxCount || size+n > maxBytes) {
			out = append(out, cur)
			cur, size = nil, 0
		}
		cur = append(cur, it)
		size += n
	}
	if len(cur) > 0 {
		out = append(out, cur)
	}
	return out
}

type fileDeleteResult struct {
	Deleted []string `json:"deleted"`
	Missing []string `json:"missing"`
	Skipped []string `json:"skipped"`
	Failed  []string `json:"failed"`
}

// deleteLiveFiles deletes paths of a live bundle in body-sized calls.
// staleOnly deletes only files a sync already marked stale (`--prune`).
func deleteLiveFiles(ctx context.Context, do apiCall, id string, paths []string, staleOnly bool) (fileDeleteResult, error) {
	res := fileDeleteResult{Deleted: []string{}, Missing: []string{}, Skipped: []string{}, Failed: []string{}}
	for _, chunk := range chunkBySize(paths, assetPathsMax, assetBodyMax) {
		body := map[string]any{"paths": chunk}
		if staleOnly {
			body["stale"] = true
		}
		var r fileDeleteResult
		if err := do(ctx, http.MethodDelete, "/assets/bundles/"+api.PathID(id)+"/files", body, &r); err != nil {
			return res, err
		}
		res.Deleted = append(res.Deleted, r.Deleted...)
		res.Missing = append(res.Missing, r.Missing...)
		res.Skipped = append(res.Skipped, r.Skipped...)
		res.Failed = append(res.Failed, r.Failed...)
	}
	return res, nil
}

func newAssetRm(a *App, bundleID bundleResolver) *cobra.Command {
	return &cobra.Command{
		Use:   "rm <bundle> <path...>",
		Short: "Delete files from a live bundle",
		Long: "Delete files from a live bundle (paths as `asset files` shows them).\n\n" +
			"No CDN invalidation happens: an immutable file stays cached at the edge,\n" +
			"so its path takes only the same bytes again for 400 days. A versioned\n" +
			"bundle deletes whole versions (`asset rm-version`).",
		Args: cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cc, id, err := bundleID(cmd, args[0], true)
			if err != nil {
				return err
			}
			res, err := deleteLiveFiles(cmd.Context(), cc.cl.Do, id, args[1:], false)
			if err != nil {
				return err
			}
			if a.jsonOut {
				if err := a.printer().JSONValue(res); err != nil {
					return err
				}
			} else {
				fmt.Fprintf(a.Out, "deleted %d\n", len(res.Deleted))
				if len(res.Missing) > 0 {
					fmt.Fprintf(a.Out, "missing %d: %s\n", len(res.Missing), strings.Join(res.Missing, ", "))
				}
				if len(res.Failed) > 0 {
					fmt.Fprintf(a.Out, "failed %d: %s\n", len(res.Failed), strings.Join(res.Failed, ", "))
				}
			}
			if len(res.Failed) > 0 {
				return fmt.Errorf("%d file(s) could not be deleted; run the command again", len(res.Failed))
			}
			return nil
		},
	}
}

// localFile is one file of the directory a sync mirrors.
type localFile struct {
	Path    string // slash-separated, relative to the directory
	Local   string // on disk
	Size    int64
	SHA256  string
	Mutable bool
}

func hashFile(p string) (string, int64, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

// matchesAny says whether rel matches one of the --mutable globs. A pattern
// with a `/` matches the whole relative path, one without also matches the
// base name (`--mutable manifest.json` finds it in any directory).
func matchesAny(globs []string, rel string) (bool, error) {
	for _, g := range globs {
		ok, err := path.Match(g, rel)
		if err != nil {
			return false, fmt.Errorf("--mutable %q: %w", g, err)
		}
		if !ok && !strings.Contains(g, "/") {
			ok, _ = path.Match(g, path.Base(rel))
		}
		if ok {
			return true, nil
		}
	}
	return false, nil
}

// syncPlan is what a sync will do, decided from the listing and the
// directory before anything is sent.
type syncPlan struct {
	Upload    []localFile `json:"-"`
	Replace   []localFile `json:"-"`
	Skip      []string    `json:"skip"`
	Fresh     []string    `json:"fresh"`
	Stale     []string    `json:"stale"`
	Prune     []string    `json:"prune"`
	Conflicts []string    `json:"conflicts"`
	// ifSHA is the remote SHA-256 each replacement expects to replace.
	ifSHA map[string]string
}

func planSync(local []localFile, remote []assetFile, live bool, prune string) syncPlan {
	p := syncPlan{Skip: []string{}, Fresh: []string{}, Stale: []string{}, Prune: []string{}, Conflicts: []string{}, ifSHA: map[string]string{}}
	byPath := map[string]assetFile{}
	for _, f := range remote {
		byPath[f.Path] = f
	}
	seen := map[string]bool{}
	for _, l := range local {
		seen[l.Path] = true
		r, ok := byPath[l.Path]
		switch {
		case !ok:
			p.Upload = append(p.Upload, l)
		case r.SHA256 != nil && *r.SHA256 == l.SHA256 && r.Mutable == l.Mutable:
			p.Skip = append(p.Skip, l.Path)
			if r.StaleSince != nil {
				p.Fresh = append(p.Fresh, l.Path)
			}
		case r.Mutable != l.Mutable:
			kind := map[bool]string{true: "mutable", false: "immutable"}
			p.Conflicts = append(p.Conflicts, fmt.Sprintf("%s: the bundle holds it as %s, --mutable says %s", l.Path, kind[r.Mutable], kind[l.Mutable]))
		case l.Mutable:
			p.Replace = append(p.Replace, l)
			if r.SHA256 != nil {
				p.ifSHA[l.Path] = *r.SHA256
			}
		case r.SHA256 == nil:
			p.Conflicts = append(p.Conflicts, l.Path+": already there, uploaded without a SHA-256, so it cannot be compared")
		default:
			p.Conflicts = append(p.Conflicts, l.Path+": already there with other bytes; an immutable file never changes")
		}
	}
	if !live {
		return p
	}
	for _, r := range remote {
		if seen[r.Path] {
			continue
		}
		switch {
		case prune == "now":
			p.Prune = append(p.Prune, r.Path)
		case r.StaleSince == nil:
			p.Stale = append(p.Stale, r.Path)
		case prune == "stale":
			// Stale since an earlier sync: the previous generation's grace is over.
			p.Prune = append(p.Prune, r.Path)
		}
	}
	return p
}

type syncReport struct {
	Uploaded  []string `json:"uploaded"`
	Replaced  []string `json:"replaced"`
	Skipped   []string `json:"skipped"`
	Fresh     []string `json:"fresh"`
	Stale     []string `json:"stale"`
	Pruned    []string `json:"pruned"`
	Conflicts []string `json:"conflicts"`
	Failed    []string `json:"failed"`
	DryRun    bool     `json:"dryRun,omitempty"`
	// Held counts the stale marks and deletions a failed run did not make.
	Held int `json:"held,omitempty"`
}

// syncer runs one plan: its API calls are rate-limited and retried, its PUTs
// retried, and every failure lands in `failed` instead of stopping the run.
type syncer struct {
	cl       *api.Client
	id       string
	version  string
	parallel int
	rl       *rateLimiter
	// progress takes one line per multipart part (stderr; nil = quiet).
	progress func(string)
	mu       sync.Mutex
	failed   []string
}

func (s *syncer) call(ctx context.Context, method, path string, in, out any) error {
	return s.callWith(ctx, defaultRetry, method, path, in, out)
}

func (s *syncer) callWith(ctx context.Context, p retryPolicy, method, path string, in, out any) error {
	return p.do(ctx, func() error {
		if err := s.rl.wait(ctx); err != nil {
			return err
		}
		return s.cl.Do(ctx, method, path, in, out)
	})
}

func (s *syncer) fail(p string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failed = append(s.failed, fmt.Sprintf("%s: %v", p, err))
}

type presignResult struct {
	Path           string            `json:"path"`
	AlreadyPresent bool              `json:"alreadyPresent"`
	UploadID       string            `json:"uploadId"`
	URL            string            `json:"url"`
	Method         string            `json:"method"`
	Headers        map[string]string `json:"headers"`
	// A file over the single-PUT ceiling: no URL, parts instead.
	Multipart bool  `json:"multipart"`
	PartSize  int64 `json:"partSize"`
	PartCount int   `json:"partCount"`
	ExpiresAt int64 `json:"expiresAt"`
	// CommitOnly: the parts are in (a `completing` upload); commit it.
	CommitOnly bool `json:"-"`
}

type commitResult struct {
	UploadID string     `json:"uploadId"`
	File     *assetFile `json:"file"`
	Error    *struct {
		Code    string          `json:"code"`
		Message string          `json:"message"`
		Details json.RawMessage `json:"details"`
	} `json:"error"`
}

// commitRounds bounds re-commits of uploads the console had no time for.
const commitRounds = 5

// send uploads files in batches: presign, PUT in parallel, batch commit
// (re-committing what the console answered "commit it again"). It returns
// the paths that are now in the bundle.
func (s *syncer) send(ctx context.Context, files []localFile, ifSHA map[string]string) []string {
	var done []string
	for start := 0; start < len(files); start += assetBatchMax {
		batch := files[start:min(start+assetBatchMax, len(files))]
		specs := make([]map[string]any, 0, len(batch))
		byPath := map[string]localFile{}
		// Multipart uploads a dead run left open resume instead of presigning.
		var resumed []presignResult
		for _, f := range batch {
			byPath[f.Path] = f
			if g := resumableUpload(ctx, s.call, s.id, f); g != nil {
				resumed = append(resumed, presignResult{Path: f.Path, UploadID: g.UploadID, Multipart: true, PartSize: g.PartSize, PartCount: g.PartCount, ExpiresAt: g.ExpiresAt, CommitOnly: g.CommitOnly})
				continue
			}
			spec := map[string]any{"path": f.Path, "size": f.Size, "sha256": f.SHA256}
			if f.Mutable {
				spec["mutable"] = true
				if sha, ok := ifSHA[f.Path]; ok {
					spec["ifSha256"] = sha
				}
			}
			specs = append(specs, spec)
		}
		var res struct {
			Uploads []presignResult `json:"uploads"`
		}
		// A path whose file row is a claim still being committed refuses the
		// presign and names the upload: that upload is committed instead, and
		// the rest of the batch is presigned again without it.
		for attempt := 0; len(specs) > 0; attempt++ {
			body := map[string]any{"files": specs}
			if s.version != "" {
				body["version"] = s.version
			}
			err := s.callWith(ctx, presignRetry, http.MethodPost, "/assets/bundles/"+api.PathID(s.id)+"/files", body, &res)
			if err == nil {
				break
			}
			if id, p, ok := committingUpload(err); ok && attempt < len(batch) {
				resumed = append(resumed, presignResult{Path: p, UploadID: id, Multipart: true, CommitOnly: true})
				kept := specs[:0]
				for _, spec := range specs {
					if spec["path"] != p {
						kept = append(kept, spec)
					}
				}
				specs = kept
				continue
			}
			for _, spec := range specs {
				s.fail(spec["path"].(string), err)
			}
			res.Uploads = nil
			break
		}
		var grants []presignResult
		for _, u := range append(res.Uploads, resumed...) {
			if u.AlreadyPresent {
				done = append(done, u.Path)
			} else {
				grants = append(grants, u)
			}
		}
		// PUT in parallel; each attempt reopens the file, so a retry sends it whole.
		put := make([]string, 0, len(grants))
		var mu sync.Mutex
		jobs := make(chan presignResult)
		var wg sync.WaitGroup
		for w := 0; w < max(1, s.parallel); w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for g := range jobs {
					f := byPath[g.Path]
					var err error
					if g.CommitOnly {
						// Nothing to send: the commit below resumes it.
					} else if g.Multipart {
						err = s.sendParts(ctx, g, f)
					} else {
						err = defaultRetry.do(ctx, func() error {
							fh, err := os.Open(f.Local)
							if err != nil {
								return err
							}
							defer fh.Close()
							return putPresigned(ctx, s.cl, uploadGrant{UploadID: g.UploadID, URL: g.URL, Method: g.Method, Headers: g.Headers}, fh, f.Size)
						})
					}
					if err != nil {
						s.fail(g.Path, err)
						continue
					}
					mu.Lock()
					put = append(put, g.UploadID)
					mu.Unlock()
				}
			}()
		}
		for _, g := range grants {
			jobs <- g
		}
		close(jobs)
		wg.Wait()
		pathOf := map[string]string{}
		for _, g := range grants {
			pathOf[g.UploadID] = g.Path
		}
		sort.Strings(put) // a stable request whatever order the PUTs finished in
		committed := s.commit(ctx, put, pathOf)
		// A committed multipart upload needs no resume any more.
		for _, p := range committed {
			if f, ok := byPath[p]; ok && f.Size > 0 {
				dropUploadState(s.id, f.SHA256)
			}
		}
		done = append(done, committed...)
	}
	return done
}

// sendParts uploads one multipart grant's parts with their own pool of
// `parallel` workers (so a batch of big files runs up to parallel² PUTs at
// once — 16 by default) and keeps the resume state until the file is
// committed.
func (s *syncer) sendParts(ctx context.Context, g presignResult, f localFile) error {
	mg := multipartGrant{UploadID: g.UploadID, PartSize: g.PartSize, PartCount: g.PartCount, Size: f.Size, ExpiresAt: g.ExpiresAt}
	if err := saveUploadState(uploadState{UploadID: g.UploadID, BundleID: s.id, Path: f.Path, SHA256: f.SHA256, Size: f.Size, ExpiresAt: g.ExpiresAt}); err != nil {
		// Not fatal: the upload still happens, only a resume is lost.
		if s.progress != nil {
			s.progress(f.Path + ": resume state not saved: " + err.Error())
		}
	}
	progress := func(line string) {
		if s.progress != nil {
			s.progress(f.Path + ": " + line)
		}
	}
	err := uploadMultipart(ctx, s.call, s.cl, mg, f.Local, s.parallel, progress)
	if errors.Is(err, errUploadGone) {
		dropUploadState(s.id, f.SHA256)
	}
	return err
}

func (s *syncer) commit(ctx context.Context, ids []string, pathOf map[string]string) []string {
	var done []string
	for round := 0; round < commitRounds && len(ids) > 0; round++ {
		if round > 0 {
			if err := sleepFor(ctx, defaultRetry.base<<round); err != nil {
				break
			}
		}
		var again []string
		var res struct {
			Results []commitResult `json:"results"`
		}
		if err := s.call(ctx, http.MethodPost, "/assets/uploads/commit", map[string]any{"ids": ids}, &res); err != nil {
			for _, id := range ids {
				s.fail(pathOf[id], err)
			}
			return done
		}
		for _, r := range res.Results {
			switch {
			case r.File != nil:
				done = append(done, r.File.Path)
			case r.Error != nil && r.Error.Code == "unavailable":
				again = append(again, r.UploadID)
			case r.Error != nil:
				s.fail(pathOf[r.UploadID], &api.Error{Code: r.Error.Code, Message: r.Error.Message, Details: r.Error.Details})
			}
		}
		ids = again
	}
	for _, id := range ids {
		s.fail(pathOf[id], fmt.Errorf("not committed after %d rounds", commitRounds))
	}
	return done
}

// mark sets or clears the stale flag in body-sized calls.
func (s *syncer) mark(ctx context.Context, key string, paths []string) []string {
	var done []string
	for _, chunk := range chunkBySize(paths, assetPathsMax, assetBodyMax) {
		if err := s.call(ctx, http.MethodPatch, "/assets/bundles/"+api.PathID(s.id)+"/files", map[string]any{key: chunk}, nil); err != nil {
			for _, p := range chunk {
				s.fail(p, err)
			}
			continue
		}
		done = append(done, chunk...)
	}
	return done
}

func newAssetSync(a *App, bundleID bundleResolver) *cobra.Command {
	var version, prune string
	var mutable []string
	var dryRun bool
	var parallel int
	var rate float64
	c := &cobra.Command{
		Use:   "sync <bundle> <dir>",
		Short: "Make a bundle hold what a directory holds, sending only what changed",
		Long: "Make a bundle hold what <dir> holds. Every file is compared by SHA-256 and\n" +
			"only new or changed bytes are sent.\n\n" +
			"A live bundle mirrors the directory: immutable files first, then the\n" +
			"files matched by --mutable (a manifest naming the others, replaced in\n" +
			"place only if nobody else changed it since the listing), then files that\n" +
			"vanished locally are marked stale. --prune deletes files that were already\n" +
			"stale before this run (the previous generation keeps working for one more\n" +
			"deploy); --prune=now deletes every file missing locally. An immutable file\n" +
			"whose bytes changed is a conflict, reported before anything is sent.\n\n" +
			"A file over 64 MiB goes up in 32 MiB parts, in parallel, and a run that\n" +
			"dies is resumed by the next one (the upload id is kept under the user\n" +
			"cache directory, $YYT_CACHE or ~/.cache/yyt, for the day S3 holds it);\n" +
			"`asset upload` and `asset push` take such files too but start over.\n\n" +
			"--version syncs one version of a versioned bundle (no --mutable, no\n" +
			"--prune): files already in the version must match.",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if prune != "" && prune != "stale" && prune != "now" {
				return fmt.Errorf("--prune takes no value or =now, not %q", prune)
			}
			cc, id, err := bundleID(cmd, args[0], true)
			if err != nil {
				return err
			}
			s := &syncer{cl: cc.cl, id: id, version: version, parallel: parallel, rl: newRateLimiter(rate)}
			if !a.jsonOut {
				s.progress = func(line string) { fmt.Fprintln(a.Err, line) }
			}
			var b assetBundle
			if err := s.call(ctx, http.MethodGet, "/assets/bundles/"+api.PathID(id), nil, &b); err != nil {
				return err
			}
			live := modeOf(b.Mode) == "live"
			switch {
			case live && version != "":
				return fmt.Errorf("%s is a live bundle: it takes no --version", args[0])
			case !live && version == "":
				return fmt.Errorf("%s is a versioned bundle: pass --version", args[0])
			case !live && (len(mutable) > 0 || prune != ""):
				return fmt.Errorf("--mutable and --prune apply to a live bundle only")
			}
			rels, err := collectAssetFiles(args[1])
			if err != nil {
				return err
			}
			local := make([]localFile, 0, len(rels))
			for _, rel := range rels {
				p := filepath.Join(args[1], filepath.FromSlash(rel))
				sha, size, err := hashFile(p)
				if err != nil {
					return err
				}
				m, err := matchesAny(mutable, rel)
				if err != nil {
					return err
				}
				local = append(local, localFile{Path: rel, Local: p, Size: size, SHA256: sha, Mutable: m})
			}
			remote, err := listAssetFiles(ctx, s.call, id, version, false)
			if err != nil {
				return err
			}
			plan := planSync(local, remote, live, prune)
			rep := syncReport{Uploaded: []string{}, Replaced: []string{}, Skipped: plan.Skip, Fresh: []string{}, Stale: []string{}, Pruned: []string{}, Conflicts: plan.Conflicts, Failed: []string{}, DryRun: dryRun}
			if dryRun || len(plan.Conflicts) > 0 {
				rep.Uploaded, rep.Replaced = paths(plan.Upload), paths(plan.Replace)
				rep.Fresh, rep.Stale, rep.Pruned = plan.Fresh, plan.Stale, plan.Prune
				rep.DryRun = true
				if err := a.printSync(rep); err != nil {
					return err
				}
				if len(plan.Conflicts) > 0 {
					return fmt.Errorf("%d conflict(s); nothing was sent", len(plan.Conflicts))
				}
				return nil
			}
			// Immutable files first, then the mutable ones that may name them:
			// a manifest must never point at a file that is not there yet.
			var imm, mut []localFile
			for _, f := range plan.Upload {
				if f.Mutable {
					mut = append(mut, f)
				} else {
					imm = append(imm, f)
				}
			}
			rep.Uploaded = append(rep.Uploaded, s.send(ctx, imm, nil)...)
			if len(s.failed) > 0 {
				// A manifest published over missing files would break clients.
				rep.Failed = s.failed
				_ = a.printSync(rep)
				return fmt.Errorf("%d file(s) failed; the mutable files were not sent", len(s.failed))
			}
			rep.Uploaded = append(rep.Uploaded, s.send(ctx, mut, nil)...)
			rep.Replaced = s.send(ctx, plan.Replace, plan.ifSHA)
			if live && len(s.failed) > 0 {
				// The manifest may still be the old one, naming files a
				// prune would delete: leave marks and deletions to a sync
				// that got everything across.
				rep.Held = len(plan.Fresh) + len(plan.Stale) + len(plan.Prune)
			} else if live {
				rep.Fresh = orEmpty(s.mark(ctx, "fresh", plan.Fresh))
				rep.Stale = orEmpty(s.mark(ctx, "stale", plan.Stale))
				if len(plan.Prune) > 0 {
					res, err := deleteLiveFiles(ctx, s.call, id, plan.Prune, prune == "stale")
					if err != nil {
						s.fail("prune", err)
					}
					rep.Pruned = res.Deleted
					for _, p := range res.Failed {
						s.fail(p, fmt.Errorf("delete failed"))
					}
				}
			}
			rep.Failed = orEmpty(s.failed)
			sort.Strings(rep.Uploaded)
			sort.Strings(rep.Replaced)
			if err := a.printSync(rep); err != nil {
				return err
			}
			if len(rep.Failed) > 0 {
				return fmt.Errorf("%d file(s) failed; run the sync again", len(rep.Failed))
			}
			return nil
		},
	}
	f := c.Flags()
	f.StringVar(&version, "version", "", "the version to sync (versioned bundles only)")
	f.StringArrayVar(&mutable, "mutable", nil, "glob of files replaced in place (live bundles; repeatable), e.g. manifest.json")
	f.StringVar(&prune, "prune", "", "delete files missing locally that an earlier sync marked stale; =now deletes them at once")
	f.Lookup("prune").NoOptDefVal = "stale"
	f.BoolVar(&dryRun, "dry-run", false, "print the plan and send nothing")
	f.IntVar(&parallel, "parallel", 4, "uploads in flight at once")
	f.Float64Var(&rate, "rate", 10, "console requests per second (0 = no limit)")
	_ = f.MarkHidden("rate")
	return c
}

func paths(fs []localFile) []string {
	out := make([]string, 0, len(fs))
	for _, f := range fs {
		out = append(out, f.Path)
	}
	return out
}

func orEmpty(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func (a *App) printSync(r syncReport) error {
	if a.jsonOut {
		return a.printer().JSONValue(r)
	}
	verb := func(done, planned string) string {
		if r.DryRun {
			return planned
		}
		return done
	}
	for _, line := range []struct {
		label string
		list  []string
	}{
		{verb("uploaded", "upload"), r.Uploaded},
		{verb("replaced", "replace"), r.Replaced},
		{verb("marked fresh", "mark fresh"), r.Fresh},
		{verb("marked stale", "mark stale"), r.Stale},
		{verb("pruned", "prune"), r.Pruned},
	} {
		for _, p := range line.list {
			fmt.Fprintf(a.Out, "%s %s\n", line.label, p)
		}
	}
	for _, c := range r.Conflicts {
		fmt.Fprintf(a.Out, "conflict %s\n", c)
	}
	for _, f := range r.Failed {
		fmt.Fprintf(a.Out, "failed %s\n", f)
	}
	if r.DryRun {
		fmt.Fprintf(a.Out, "plan: %d to upload, %d to replace, %d unchanged, %d to mark stale, %d to prune, %d conflict(s)\n",
			len(r.Uploaded), len(r.Replaced), len(r.Skipped), len(r.Stale), len(r.Pruned), len(r.Conflicts))
		return nil
	}
	if r.Held > 0 {
		fmt.Fprintf(a.Out, "held back %d stale mark(s) and deletion(s): a file failed, so the bundle may still name the old ones\n", r.Held)
	}
	fmt.Fprintf(a.Out, "done: %d uploaded, %d replaced, %d unchanged, %d marked stale, %d pruned, %d failed\n",
		len(r.Uploaded), len(r.Replaced), len(r.Skipped), len(r.Stale), len(r.Pruned), len(r.Failed))
	return nil
}
