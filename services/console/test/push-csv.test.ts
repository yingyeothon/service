import { describe, expect, it } from "vitest";
import {
  createCsvReader,
  csvCell,
  csvLine,
  CsvError,
  isTokenColumn,
  parseCsvHeader,
  PUSH_CSV_COLUMNS_MAX,
  PUSH_CSV_FIELD_MAX_BYTES,
  PUSH_CSV_ROW_MAX_BYTES,
  readCsv,
  type CsvFailure,
} from "../src/push-csv.js";

const bytes = (s: string) => Buffer.from(s, "utf8");

/** Every record of `input`, fed in chunks of `size` bytes. */
function records(input: string | Buffer, size = 7): string[][] {
  const buf = typeof input === "string" ? bytes(input) : input;
  const reader = createCsvReader();
  const out: string[][] = [];
  for (let at = 0; at < buf.length; at += size)
    for (const r of reader.push(buf.subarray(at, at + size)))
      out.push(r.fields);
  for (const r of reader.end()) out.push(r.fields);
  return out;
}

function failure(input: string | Buffer, size = 7) {
  try {
    records(input, size);
  } catch (e) {
    if (e instanceof CsvError) return { reason: e.reason, line: e.line };
    throw e;
  }
  return undefined;
}

async function* chunked(buf: Buffer, size: number) {
  for (let at = 0; at < buf.length; at += size)
    yield buf.subarray(at, at + size);
}

async function readAll(input: string, size = 5) {
  const out: (string[] | { header: string[] })[] = [];
  for await (const rec of readCsv(chunked(bytes(input), size)))
    out.push("header" in rec ? { header: rec.header.columns } : rec.row);
  return out;
}

async function readFailure(input: string) {
  try {
    await readAll(input);
  } catch (e) {
    if (e instanceof CsvError) return { reason: e.reason, line: e.line };
    throw e;
  }
  return undefined;
}

describe("csv reader", () => {
  it("reads LF and CRLF records, with or without a final line break", () => {
    const want = [
      ["a", "b"],
      ["1", "2"],
      ["3", ""],
    ];
    for (const s of [
      "a,b\n1,2\n3,\n",
      "a,b\r\n1,2\r\n3,\r\n",
      "a,b\n1,2\r\n3,",
    ])
      for (const size of [1, 2, 3, 100]) expect(records(s, size)).toEqual(want);
  });

  it("skips a byte-order mark, whole or split over chunks, and nothing that only looks like one", () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    for (const size of [1, 2, 3, 4, 100])
      expect(records(Buffer.concat([bom, bytes("a,b\n")]), size)).toEqual([
        ["a", "b"],
      ]);
    // `ï»` followed by something else is data.
    const partial = Buffer.concat([Buffer.from([0xc3, 0xaf]), bytes("x\n")]);
    expect(records(partial, 1)).toEqual([["ïx"]]);
    // A mark in the middle is not skipped: it is part of the field.
    expect(records(Buffer.concat([bytes("a\n"), bom, bytes("b\n")]))).toEqual([
      ["a"],
      ["﻿b"],
    ]);
    // A file that is only (part of) a mark holds no record.
    expect(records(bom)).toEqual([]);
    expect(failure(Buffer.from([0xef, 0xbb]))).toEqual({
      reason: "invalid_utf8",
      line: 1,
    });
  });

  it("reads quoted fields: commas, doubled quotes, line breaks, empty", () => {
    expect(
      records('"a,b","say ""hi""","line1\nline2\r\nline3",""\nx,"",y,"z"\n'),
    ).toEqual([
      ["a,b", 'say "hi"', "line1\nline2\r\nline3", ""],
      ["x", "", "y", "z"],
    ]);
    // A quoted empty field makes a record; an empty line does not.
    expect(records('""\n\n\r\n"a"\n\n')).toEqual([[""], ["a"]]);
  });

  it("decodes UTF-8 split anywhere and refuses bytes that are not UTF-8", () => {
    for (const size of [1, 2, 3, 5])
      expect(records("이름,값\n가나다,😀\n", size)).toEqual([
        ["이름", "값"],
        ["가나다", "😀"],
      ]);
    expect(failure(Buffer.from([0x61, 0xff, 0x0a]))).toEqual({
      reason: "invalid_utf8",
      line: 1,
    });
    expect(
      failure(Buffer.concat([bytes("a\n"), Buffer.from([0xe3, 0x81])])),
    ).toEqual({ reason: "invalid_utf8", line: 2 });
  });

  it("refuses malformed quoting, bare CR and NUL, naming the record", () => {
    const cases: [string, CsvFailure, number][] = [
      ['a\nb"c\n', "quote", 2],
      ['a\n"b"c\n', "quote", 2],
      ['"a" ,b\n', "quote", 1],
      ['a,"b\n', "unterminated_quote", 1],
      ['a\n"b\nc\nd', "unterminated_quote", 2],
      ["a\rb\n", "bare_cr", 1],
      ["a\n\rb", "bare_cr", 2],
      ["a\nb\r", "bare_cr", 2],
      ["a\n\u0000\n", "nul_byte", 2],
      ['a\n"\u0000"\n', "nul_byte", 2],
    ];
    for (const [input, reason, line] of cases)
      for (const size of [1, 100])
        expect(failure(input, size), JSON.stringify(input)).toEqual({
          reason,
          line,
        });
  });

  it("holds the per-record, per-field and per-record-columns limits", () => {
    const field = "x".repeat(PUSH_CSV_FIELD_MAX_BYTES);
    const rest = "y".repeat(PUSH_CSV_FIELD_MAX_BYTES - 1);
    // 512 + a comma + 511 bytes: exactly the record limit.
    expect(records(`${field},${rest}\n`, 100)).toEqual([[field, rest]]);
    expect(failure(`a\n${field}x\n`, 100)).toEqual({
      reason: "field_too_long",
      line: 2,
    });
    // One more comma is one byte over.
    expect(failure(`a\n${field},${rest},\n`, 64)).toEqual({
      reason: "row_too_long",
      line: 2,
    });
    expect(PUSH_CSV_ROW_MAX_BYTES).toBe(1024);
    // Quotes count toward the record; the line break does not.
    const exact = `"${"x".repeat(510)}","${"y".repeat(509)}"`;
    expect(Buffer.byteLength(exact)).toBe(PUSH_CSV_ROW_MAX_BYTES);
    expect(records(`${exact}\r\n`, 100)).toHaveLength(1);
    // A quoted line break counts.
    expect(failure(`"${"x\n".repeat(600)}"`, 100)?.reason).toBe(
      "field_too_long",
    );
    const cols = (n: number) => Array.from({ length: n }, () => "a").join(",");
    expect(records(`${cols(PUSH_CSV_COLUMNS_MAX)}\n`)[0]).toHaveLength(32);
    expect(failure(`${cols(PUSH_CSV_COLUMNS_MAX + 1)}\n`)).toEqual({
      reason: "too_many_columns",
      line: 1,
    });
  });

  it("takes custom limits", () => {
    const reader = createCsvReader({
      rowMaxBytes: 5,
      fieldMaxBytes: 3,
      columnsMax: 2,
    });
    expect(reader.push(bytes("abc,d\n"))).toEqual([
      { fields: ["abc", "d"], line: 1 },
    ]);
    expect(() => reader.push(bytes("abcd\n"))).toThrow(CsvError);
  });
});

describe("csv header", () => {
  it("needs userId and takes variable names beside it", () => {
    expect(parseCsvHeader(["name", "userId", "_x1"])).toEqual({
      columns: ["name", "userId", "_x1"],
      userIndex: 1,
    });
    expect(parseCsvHeader(["userId"])).toEqual({
      columns: ["userId"],
      userIndex: 0,
    });
  });

  it("refuses a missing or misspelt userId, a bad name and a duplicate", () => {
    const reason = (fields: string[]) => {
      try {
        parseCsvHeader(fields);
      } catch (e) {
        return (e as CsvError).reason;
      }
      return undefined;
    };
    expect(reason(["name"])).toBe("user_column_missing");
    expect(reason(["userid"])).toBe("user_column_missing");
    expect(reason(["UserId", "name"])).toBe("user_column_missing");
    expect(reason(["userId", "first name"])).toBe("header_name");
    expect(reason(["userId", ""])).toBe("header_name");
    expect(reason(["userId", "1st"])).toBe("header_name");
    expect(reason(["userId", "이름"])).toBe("header_name");
    expect(reason(["userId", "a", "a"])).toBe("duplicate_header");
    expect(reason(["userId", "userId"])).toBe("duplicate_header");
    // Case-sensitive, like the variables: these are two columns.
    expect(reason(["userId", "a", "A"])).toBeUndefined();
  });

  it("refuses a column shaped like a device token", () => {
    for (const name of [
      "token",
      "Token",
      "tokens",
      "deviceToken",
      "device_token",
      "fcmToken",
      "FCM_TOKEN",
      "registrationToken",
      "registration_id",
      "pushToken",
      "firebase_token",
      "instanceId",
    ]) {
      expect(isTokenColumn(name), name).toBe(true);
      expect(() => parseCsvHeader(["userId", name]), name).toThrow(
        "token_column",
      );
    }
    for (const name of ["tokenCount", "coupon", "giftTokenName", "id", "name"])
      expect(isTokenColumn(name), name).toBe(false);
  });
});

describe("readCsv", () => {
  it("yields the checked header, then rows of exactly its width", async () => {
    expect(await readAll('userId,name\r\nu1,Ann\n\nu2,"B,ob"\n')).toEqual([
      { header: ["userId", "name"] },
      ["u1", "Ann"],
      ["u2", "B,ob"],
    ]);
    expect(await readAll("userId")).toEqual([{ header: ["userId"] }]);
  });

  it("refuses an empty input, a bad header and a row of another width", async () => {
    expect(await readFailure("")).toEqual({ reason: "empty", line: 1 });
    expect(await readFailure("\n\n")).toEqual({ reason: "empty", line: 1 });
    expect(await readFailure("name\nx\n")).toEqual({
      reason: "user_column_missing",
      line: 1,
    });
    expect(await readFailure("userId,token\nu,t\n")).toEqual({
      reason: "token_column",
      line: 1,
    });
    expect(await readFailure("userId,a\nu1,1\nu2\n")).toEqual({
      reason: "column_count",
      line: 3,
    });
    expect(await readFailure("userId,a\nu1,1,2\n")).toEqual({
      reason: "column_count",
      line: 2,
    });
    expect(await readFailure('userId\nu1\n"u2\n')).toEqual({
      reason: "unterminated_quote",
      line: 3,
    });
  });

  it("parses the same records wherever the chunks are cut", () => {
    const src = Buffer.from(
      '\ufeffuserId,name,x\r\n"a""b",한글🎉,"multi\r\nline, ""q"""\n\nplain,"",z\r\n"é",ü,last',
      "utf8",
    );
    const parse = (size: number) => {
      const r = createCsvReader();
      const out = [];
      for (let at = 0; at < src.length; at += size)
        out.push(...r.push(src.subarray(at, at + size)));
      out.push(...r.end());
      return out;
    };
    const whole = parse(src.length);
    expect(whole.map((r) => r.fields)).toEqual([
      ["userId", "name", "x"],
      ['a"b', "한글🎉", 'multi\r\nline, "q"'],
      ["plain", "", "z"],
      ["é", "ü", "last"],
    ]);
    for (let size = 1; size < src.length; size++)
      expect(parse(size), `chunks of ${size}`).toEqual(whole);
  });

  it("streams 100,000 rows from 64 KiB chunks without holding the file", async () => {
    const N = 100_000;
    const hex = (i: number) => i.toString(16).padStart(32, "0");
    // The source makes each chunk on demand: nothing holds the whole file.
    async function* source() {
      let pending = "userId,name\n";
      let made = 0;
      while (made < N || pending.length > 0) {
        while (made < N && pending.length < 65_536)
          pending += `${hex(made)},"player ${made++}"\n`;
        const chunk = bytes(pending.slice(0, 65_536));
        pending = pending.slice(65_536);
        yield chunk;
      }
    }
    let rows = 0;
    let lastUser = "";
    let lastName = "";
    let pulled = 0;
    let maxAhead = 0;
    async function* counted() {
      for await (const c of source()) {
        pulled += c.length;
        yield c;
      }
    }
    for await (const rec of readCsv(counted())) {
      if ("header" in rec) continue;
      rows++;
      [lastUser, lastName] = rec.row as [string, string];
      // The reader is never more than one chunk ahead of its consumer.
      if (rows % 10_000 === 0)
        maxAhead = Math.max(maxAhead, pulled - rows * 40);
    }
    expect(rows).toBe(N);
    expect(lastUser).toBe(hex(N - 1));
    expect(lastName).toBe(`player ${N - 1}`);
    expect(maxAhead).toBeLessThan(2_000_000);
  });
});

describe("report cells", () => {
  it("neutralises what a spreadsheet would run as a formula", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\t=1")).toBe("'\t=1");
    expect(csvCell("\r=1")).toBe('"\'\r=1"');
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(
      '"\'=HYPERLINK(""http://x"",""y"")"',
    );
    // Not at the start: left alone.
    expect(csvCell("a=1")).toBe("a=1");
    expect(csvCell("no-token")).toBe("no-token");
  });

  it("quotes, drops control characters and cuts long values", () => {
    expect(csvCell("")).toBe("");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell("a\u0000b\u0007c\u001b")).toBe("abc");
    expect(csvCell("x".repeat(500))).toBe("x".repeat(128));
    expect(csvLine(["u1", "failed", "rejected"])).toBe("u1,failed,rejected\n");
    expect(csvLine(["=u", "skipped", ""])).toBe("'=u,skipped,\n");
  });
});
