import { PUSH_VAR_NAME } from "./push-template.js";

/*
 * The recipient CSV of a push campaign (`docs/push.md` *Recipient CSV*): a
 * strict RFC 4180 reader that works on byte chunks, so a 100,000-row file is
 * never held in memory, and the header rules.
 *
 *   - UTF-8; a leading byte-order mark is skipped; invalid UTF-8 is an error.
 *   - Records end in LF or CRLF. A CR that is not followed by LF is an error,
 *     as is a NUL byte.
 *   - A field is quoted as a whole or not at all: `"` may open a field only
 *     at its first byte, `""` is a quote inside it, and the closing quote
 *     must be followed by a comma or the end of the record. A quoted field
 *     may hold commas and line breaks.
 *   - An empty line is skipped and counts as no row.
 *   - Limits: bytes per record, bytes per field, fields per record.
 *
 * No dependency: the repository has no CSV reader, and this one is small
 * enough to own (`rules/security.md`, parsers of untrusted input).
 */

/** A record (the header included) is at most this many bytes. */
export const PUSH_CSV_ROW_MAX_BYTES = 1024;
/** One field is at most this many bytes. */
export const PUSH_CSV_FIELD_MAX_BYTES = 512;
/** Columns of the header, `userId` included. */
export const PUSH_CSV_COLUMNS_MAX = 32;
/** The required column: a user id of the push channel's auth channel. */
export const PUSH_CSV_USER_COLUMN = "userId";

export type CsvFailure =
  | "empty"
  | "invalid_utf8"
  | "nul_byte"
  | "bare_cr"
  | "quote"
  | "unterminated_quote"
  | "row_too_long"
  | "field_too_long"
  | "too_many_columns"
  | "column_count"
  | "header_name"
  | "duplicate_header"
  | "user_column_missing"
  | "token_column";

/** A file-level refusal: the whole CSV is turned away, nothing is sent. */
export class CsvError extends Error {
  constructor(
    readonly reason: CsvFailure,
    /** 1-based record number where the reader stopped; the header is 1. */
    readonly line: number,
  ) {
    super(`csv ${reason} at line ${line}`);
    this.name = "CsvError";
  }
}

export interface CsvLimits {
  rowMaxBytes: number;
  fieldMaxBytes: number;
  columnsMax: number;
}

export const PUSH_CSV_LIMITS: CsvLimits = {
  rowMaxBytes: PUSH_CSV_ROW_MAX_BYTES,
  fieldMaxBytes: PUSH_CSV_FIELD_MAX_BYTES,
  columnsMax: PUSH_CSV_COLUMNS_MAX,
};

export interface CsvRecord {
  fields: string[];
  /** 1-based record number, skipped empty lines not counted. */
  line: number;
}

const COMMA = 0x2c;
const QUOTE = 0x22;
const CR = 0x0d;
const LF = 0x0a;
const BOM = [0xef, 0xbb, 0xbf];

/**
 * The byte-level reader. `push` returns the records a chunk completed;
 * `end` returns the last one when the input did not end in a line break.
 * Both throw {@link CsvError}. A chunk may end anywhere, inside a multi-byte
 * character or between a CR and its LF.
 */
export function createCsvReader(limits: CsvLimits = PUSH_CSV_LIMITS) {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const field = Buffer.allocUnsafe(limits.fieldMaxBytes);
  let fieldLen = 0;
  let fields: string[] = [];
  /** Bytes of the current record, separators and quotes included. */
  let rowBytes = 0;
  let line = 1;
  /** `start`: at a field's first byte; `quoted`; `closed`: after a closing quote. */
  let state: "start" | "plain" | "quoted" | "closed" = "start";
  let pendingCr = false;
  /** Bytes of the input seen so far, for the byte-order mark. */
  let offset = 0;
  let bomSeen = 0;

  const fail = (reason: CsvFailure): never => {
    throw new CsvError(reason, line);
  };
  const endField = (): void => {
    try {
      fields.push(decoder.decode(field.subarray(0, fieldLen)));
    } catch {
      fail("invalid_utf8");
    }
    fieldLen = 0;
    if (fields.length > limits.columnsMax) fail("too_many_columns");
  };
  const add = (b: number): void => {
    if (fieldLen >= limits.fieldMaxBytes) fail("field_too_long");
    field[fieldLen++] = b;
  };
  const endRecord = (out: CsvRecord[]): void => {
    // An empty line: no byte before the line break.
    if (state === "start" && fields.length === 0 && fieldLen === 0) {
      rowBytes = 0;
      return;
    }
    endField();
    out.push({ fields, line });
    fields = [];
    rowBytes = 0;
    line++;
    state = "start";
  };

  function step(b: number, out: CsvRecord[]): void {
    if (pendingCr) {
      pendingCr = false;
      if (b !== LF) fail("bare_cr");
      endRecord(out);
      return;
    }
    // A line break outside quotes ends the record and is not part of it.
    if (state !== "quoted" && (b === CR || b === LF)) {
      if (b === CR) pendingCr = true;
      else endRecord(out);
      return;
    }
    if (++rowBytes > limits.rowMaxBytes) fail("row_too_long");
    if (state === "quoted") {
      if (b === QUOTE) state = "closed";
      else if (b === 0) fail("nul_byte");
      else add(b);
      return;
    }
    if (state === "closed") {
      if (b === QUOTE) {
        add(QUOTE);
        state = "quoted";
        return;
      }
      if (b !== COMMA) fail("quote");
    }
    switch (b) {
      case COMMA:
        endField();
        state = "start";
        return;
      case QUOTE:
        if (state !== "start") fail("quote");
        state = "quoted";
        return;
      case 0:
        return fail("nul_byte");
      default:
        add(b);
        state = "plain";
    }
  }

  return {
    push(chunk: Uint8Array): CsvRecord[] {
      const out: CsvRecord[] = [];
      for (let i = 0; i < chunk.length; i++) {
        const b = chunk[i]!;
        // The mark is three bytes at offset 0 and may straddle chunks.
        if (offset < 3 && offset === bomSeen && b === BOM[offset]) {
          bomSeen++;
          offset++;
          continue;
        }
        if (bomSeen > 0 && bomSeen < 3) {
          // A partial mark was something else: replay what was held back.
          const held = BOM.slice(0, bomSeen);
          bomSeen = 0;
          offset = 3;
          for (const h of held) step(h, out);
        }
        offset++;
        step(b, out);
      }
      return out;
    },
    end(): CsvRecord[] {
      const out: CsvRecord[] = [];
      if (bomSeen > 0 && bomSeen < 3) {
        const held = BOM.slice(0, bomSeen);
        bomSeen = 0;
        for (const h of held) step(h, out);
      }
      if (pendingCr) fail("bare_cr");
      if (state === "quoted") fail("unterminated_quote");
      if (state !== "start" || fields.length > 0 || fieldLen > 0)
        endRecord(out);
      return out;
    },
  };
}

export interface CsvHeader {
  columns: string[];
  /** Index of {@link PUSH_CSV_USER_COLUMN}. */
  userIndex: number;
}

/**
 * Whether a column name reads like a device token. Such a header is refused
 * outright: recipients are named by user id, and a device token must never
 * travel through a team's file (decisions #5, #9).
 */
export function isTokenColumn(name: string): boolean {
  const n = name.toLowerCase().replace(/_/g, "");
  return (
    /^(?:fcm|device|registration|push|firebase|instance)?(?:token|tokens)$/.test(
      n,
    ) || /^(?:registration|instance)ids?$/.test(n)
  );
}

/**
 * The header record: every name a variable name (`[A-Za-z_][A-Za-z0-9_]{0,31}`,
 * case-sensitive), no name twice, `userId` among them, none shaped like a
 * device token. Throws {@link CsvError} at line 1.
 */
export function parseCsvHeader(fields: readonly string[]): CsvHeader {
  const fail = (reason: CsvFailure): never => {
    throw new CsvError(reason, 1);
  };
  const seen = new Set<string>();
  for (const name of fields) {
    if (!PUSH_VAR_NAME.test(name)) fail("header_name");
    if (seen.has(name)) fail("duplicate_header");
    if (isTokenColumn(name)) fail("token_column");
    seen.add(name);
  }
  const userIndex = fields.indexOf(PUSH_CSV_USER_COLUMN);
  if (userIndex < 0) fail("user_column_missing");
  return { columns: [...fields], userIndex };
}

/**
 * The records of a CSV read from byte chunks: the header first (already
 * checked), then each data row with exactly as many fields as the header
 * (`column_count` otherwise). An input without a header is `empty`.
 */
export async function* readCsv(
  chunks: AsyncIterable<Uint8Array>,
  limits: CsvLimits = PUSH_CSV_LIMITS,
): AsyncGenerator<
  { header: CsvHeader } | { row: string[]; line: number },
  void,
  void
> {
  const reader = createCsvReader(limits);
  let header: CsvHeader | undefined;
  function* emit(records: CsvRecord[]) {
    for (const r of records) {
      if (!header) {
        header = parseCsvHeader(r.fields);
        yield { header };
        continue;
      }
      if (r.fields.length !== header.columns.length)
        throw new CsvError("column_count", r.line);
      yield { row: r.fields, line: r.line };
    }
  }
  for await (const chunk of chunks) yield* emit(reader.push(chunk));
  yield* emit(reader.end());
  if (!header) throw new CsvError("empty", 1);
}

/* ------------------------------------------------------------------ */
/* report output                                                       */
/* ------------------------------------------------------------------ */

const REPORT_CELL_MAX = 128;

/**
 * One cell of the report. A value that a spreadsheet would run as a formula
 * (leading `=`, `+`, `-`, `@`, tab or CR) is prefixed with `'`; control
 * characters are dropped; a long value is cut; quotes, commas and line breaks
 * are quoted the RFC 4180 way.
 */
export function csvCell(value: string): string {
  // eslint-disable-next-line no-control-regex -- dropping control chars is the point
  let v = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  if (v.length > REPORT_CELL_MAX) v = v.slice(0, REPORT_CELL_MAX);
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** One report line, LF-terminated. */
export const csvLine = (cells: readonly string[]): string =>
  `${cells.map(csvCell).join(",")}\n`;
