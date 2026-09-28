# Asset encryption format (`yyt-enc v1`)

Status: decided 2026-09-28 (`docs/decisions.md` _Live and encrypted asset bundles_ #4); built 2026-09-28 (`todo/46` P4): the Go implementation is `cli/internal/assetcrypt`, the vectors are `docs/asset-encryption-vectors.json`, and a disagreement between this text and the vectors is a bug, settled by the independent checks in [Test vectors](#test-vectors).

## Roles

- **Encryptor:** the `yyt` CLI only (`yyt asset sync`). It fetches the bundle key from the console and encrypts on the operator's machine.
- **Decryptors:**
  - the `asset-client` wire package of tslib, csharplib and flutterlib;
  - `yyt asset download`, which fetches and decrypts one file to verify an upload.
- **The console and the CDN never encrypt or decrypt.** They store and serve ciphertext as `application/octet-stream`, with the sha256 of the ciphertext.

## Key

- One key per encrypted bundle: 32 random bytes minted by the console, stored wrapped by the stage KEK.
- **Text form:** `yak1.` followed by the unpadded base64url encoding of the 32 bytes (43 characters). The prefix names the format version and lets secret scanners find a pasted key.
- **Parsing:** accept exactly that prefix and 43 characters of the base64url alphabet that decode to 32 bytes and re-encode to the same text (the last character is one of `AEIMQUYcgkosw048`); anything else is `bad_key`. A lenient and a strict decoder must never disagree on which texts are keys.
- **Handling:** the key is readable by the bundle's team and embedded in the consumer app. It is never logged and never committed; `.gitleaks.toml` gains a `yak1.` rule with the implementation (`todo/46` P4).

## Ciphertext

A file's ciphertext is a Tink **AES-CTR-HMAC Streaming AEAD** ciphertext with these parameters:

- DerivedKeySize 32 (AES-256)
- HkdfHashType SHA256
- HmacHashType SHA256
- HmacTagSize 32
- CiphertextSegmentSize 65,536
- ciphertext offset 0

The associated data `AD` is the file's object key below the bundle, UTF-8, no leading slash: `{path}` in a live bundle (`data/songs.db`) and `{version}/{path}` in a versioned one (`v3/data/songs.db`). Binding the version keeps the same file in two versions from encrypting to the same bytes, so neither equality nor a copy across versions is visible or possible.

The format differs from Tink in one place only: how the salt and nonce prefix are chosen (next section). A Tink implementation decrypts the result unchanged.

With `K` the bundle key:

- **Header** (40 bytes): `0x28` ‖ `salt` (32 bytes) ‖ `noncePrefix` (7 bytes). `0x28` is the header length.
- **Segment keys:** `k_enc ‖ k_mac = HKDF-SHA256(ikm = K, salt = salt, info = AD, L = 64)`. `k_enc` is the first 32 bytes (AES-256) and `k_mac` the last 32 (HMAC-SHA256).
- **Segments** `M_0 … M_{n−1}`, with `n ≥ 1`:
  - `M_0` holds 0 to 65,464 bytes (65,536 − 40 − 32).
  - Every later segment holds 1 to 65,504 bytes (65,536 − 32).
  - Every segment but the last is full. An empty file is one empty `M_0`.
- **IV:** `IV_i = noncePrefix ‖ u32be(i) ‖ last ‖ 0x00000000`, 16 bytes.
  - `last` is `0x01` for segment `n−1` and `0x00` otherwise.
  - The final 4 bytes are the AES-CTR block counter.
- **Encryption and tag:**
  - `C'_i = AES-256-CTR(k_enc, IV_i, M_i)`
  - `T_i = HMAC-SHA256(k_mac, IV_i ‖ C'_i)`, all 32 bytes
  - Segment `i` on the wire is `C'_i ‖ T_i`.
- **File:** `header ‖ segment_0 ‖ … ‖ segment_{n−1}`.
- **Offsets:**
  - Segment 0 starts at byte 40; segment `i ≥ 1` starts at byte `65,536 · i`.
  - A full segment 0 is 65,496 bytes; a full later segment is 65,536.
  - Ciphertext length `L = P + 40 + 32 n` for plaintext length `P`.
- **Segment count:**
  - If `P ≤ 65,464`, then `n = 1`.
  - Otherwise `n = 1 + ⌈(P − 65,464) / 65,504⌉`.

## Deterministic salt and nonce prefix

This is the one deviation from Tink, which draws the salt and nonce prefix at random.

```
K_det               = HKDF-SHA256(ikm = K, salt = none, info = "yyt-enc v1 det",    L = 32)
D                   = HMAC-SHA256(K_det, u32be(len(AD)) ‖ AD ‖ plaintext)
salt ‖ noncePrefix  = HKDF-SHA256(ikm = D, salt = none, info = "yyt-enc v1 header", L = 39)
```

`salt = none` is HKDF's default: 32 zero bytes.

- **Same input, same bytes.** The same plaintext at the same path under the same key always yields the same bytes. The platform relies on this for three rules:
  - an unchanged file re-uploads as "already present";
  - `yyt asset sync` skips it;
  - an immutable path accepts it again (a changed file is a 409).
- **Different input, independent keys.** A different plaintext or `AD` yields a different `D`, a different salt, and so independent segment keys. For `k_enc` and an `IV` to repeat, two different inputs would need the same salt, which takes an HMAC-SHA256 collision — **provided the salt was derived from the very bytes that were encrypted** (the rule after next).
- **What it reveals.** To anyone without the key: the path, the exact plaintext length (`P = L − 40 − 32 n`), and whether two ciphertexts under one `AD` are equal — that is, whether the file at a path changed. The bundle listing shows the path, the size and the change anyway.
- **Encrypting reads the plaintext twice, and the second pass proves it read the same bytes.** The first pass computes `D`; the second recomputes `D` over the bytes it actually encrypts and discards its output unless the two agree. Otherwise a file that changes between the passes gets content B under the salt of content A, and wherever A's ciphertext exists under the same `AD` the two share a keystream on a public CDN. An encryptor that holds the whole file in memory reads it once. A test proves that two plaintexts under one `AD` produce different headers.
- **Decrypting never recomputes `D`.** A decryptor cannot tell a derived salt from a random one, and does not need to.
- **The console checks shape, not authenticity.** A presign into an encrypted bundle needs `format: "yyt-enc-v1"` and a size that is a ciphertext length; a commit reads the object's first byte and refuses anything but `0x28` (a multipart object right after its completion, and again on a retried commit and in the daily sweep, since that check runs only once the object exists). A file that starts with `(` at a ciphertext length passes. Only the bundle's own team can put such a file there, so the promise is that no uploader does it _by accident_, not a cryptographic one. The per-file ceiling (`asset.fileBytes`) is applied to the plaintext length `L − 40 − 32 n`, so a file of exactly the ceiling fits; storage totals count the ciphertext.

## Decrypting a whole file

The ciphertext length `L` comes from `Content-Length`, or from `Content-Range` on a ranged response.

1. Refuse unless `72 ≤ L ≤` the platform's file ceiling plus the format's overhead (268,566,664 bytes today: 256 MiB of plaintext is 4,099 segments, so 40 + 32 × 4,099 bytes of overhead) and the first byte is `0x28`. There are no other header fields to read: the segment size is fixed by the version, never read from the file. Tink also refuses segment numbers of 2³² − 1 and above; the ceiling stays far below them.
2. Derive `n` and every segment's extent from `L`:
   - If `L ≤ 65,536`, then `n = 1`.
   - Otherwise `n = 1 + ⌈(L − 65,536) / 65,536⌉`, and the last segment's ciphertext, `L − 65,536 · (n − 1)`, must be at least 33 bytes.
   - Any other `L` is `asset_corrupt`.
3. Derive `k_enc ‖ k_mac` from `K`, the salt and `AD`.
4. For each segment, recompute `T_i` with the right `last` flag and compare it **in constant time before releasing any byte of `M_i`**. A mismatch is `asset_corrupt`, never retried as a different path or key. A whole-file read returns nothing on a mismatch; a download writes to a temporary file and renames it only after the last segment verifies.
   - netstandard2.0 has no `CryptographicOperations.FixedTimeEquals`: XOR-accumulate every byte.
5. A file must end exactly after segment `n−1`, which is how truncation and extension fail. Reordering, splicing between files or paths, and a wrong key or path all fail the tag.

## Ranged reads and resume

- **Segment of a plaintext offset:** `seg(p) = 0` if `p < 65,464`, else `1 + ⌊(p − 65,464) / 65,504⌋`.
- **Segment starts:**
  - plaintext: `pstart(0) = 0` and `pstart(i) = 65,464 + 65,504 (i − 1)`
  - ciphertext: `cstart(0) = 40` and `cstart(i) = 65,536 i`
- **Reading plaintext `[a, b)`:**
  1. Fetch the header (bytes 0–39) once per file.
  2. Fetch ciphertext from `cstart(seg(a))` to the end of segment `seg(b − 1)`. The total length `L` from `Content-Range` tells which segment is last.
  3. Verify each segment, then slice.
  - Every request after the first carries `If-Range` (or `If-Match`) with the first response's `ETag` and must see the same total length, because a mutable file can change between the header and a later segment. On a change the read restarts from the header instead of reporting `asset_corrupt`. A 206 without a numeric total length is an `http` error.
- **Resume:** a resumed download keeps only verified segments and the `ETag` it started with. It continues from the first unverified segment's `cstart` under `If-Range`, so it re-fetches at most one segment, and starts over if the object changed. CloudFront serves `Range` from cache, and the object is `application/octet-stream`, which CloudFront does not compress.

## `asset-client` outline

Each library adapts the names to its idiom but keeps one vocabulary across the three.

- `open(baseUrl, { key? })` returns a bundle.
  - `baseUrl` is `https://{cdn}/assets/{bundleId}/` for a live bundle, plus `{version}/` for a versioned one.
  - Without `key`, it reads a plain bundle.
- **Reads:**
  - `read(path)` returns the whole file, verified.
  - `readJson(path)`
  - `readRange(path, start, end)`
  - `download(path, destination, { resume, onProgress })` streams to storage and resumes as above.
- **Errors:**
  - `bad_key`
  - `not_found`: 403 or 404. A missing object answers 403 on this CDN (`docs/decisions.md` _CDN cost guard_ §11).
  - `asset_corrupt`
  - `http`: any other status
  - `network`
- **Handling rule:** never log the key or the plaintext, and zero key material where the platform allows it.

## Test vectors

`docs/asset-encryption-vectors.json` lists each positive case's `name`, `keyHex`, `key` (the `yak1.` text form), `path`, `plaintextUnitHex`, `plaintextLength` and `ciphertextHex`, and each negative case's `name`, `keyHex`, `key`, `path`, `ciphertextHex` and `error`. The plaintext is `plaintextUnitHex` repeated and cut to `plaintextLength` bytes (a 1 KiB unit keeps the file near 1 MB; the ciphertexts are given in full). The file is generated by `go test ./internal/assetcrypt -update` in `cli/`, and the same test fails when the file and the implementation disagree.

- **Vector key:** its hex is `0123456789abcdef` repeated four times, in every case — the "wrong key" case keeps that key and carries bytes made under another one, so the file holds one key text. That hex is the pattern `.gitleaks.toml` already allowlists, and the `yak1.` rule allowlists the vector's text form by value.
- **Positive cases:**
  - an empty file and a 1-byte file;
  - 65,464 bytes (one full first segment) and 65,465 bytes (two segments, the last 1 byte);
  - 130,968 bytes (two full segments);
  - three segments (131,100 bytes);
  - a non-ASCII path.
- **Negative cases**, each expected to fail as `asset_corrupt`:
  - a flipped tag byte and a flipped ciphertext byte;
  - a file truncated by one segment, and one truncated inside its last segment;
  - appended bytes;
  - two segments swapped;
  - the wrong path, and the wrong key;
  - a header length byte other than `0x28`.
- **Independent checks.** The Go CLI produces the file. Two separate implementations must accept every positive case and reject every negative one:
  - a node:crypto decryptor in the console's tests, using `hkdfSync`, `createHmac` and `aes-256-ctr`;
  - tink-go's AES-CTR-HMAC streaming primitive in the CLI's tests, which checks the Tink compatibility claimed above.

  The library packages run the same file as their conformance test.
