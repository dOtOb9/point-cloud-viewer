// @vitest-environment node
import { describe, expect, it } from "vitest";
import { findBuildMachinePaths } from "./check-wasm-paths.mjs";
import { encodedRustflagsWith, remapPathPrefixFlags } from "./build-wasm.mjs";

function bytesOf(...strings) {
  return Buffer.from(["\0\x01", ...strings, "\0"].join("\0\x02"), "latin1");
}

describe("check-wasm-paths", () => {
  it("finds the paths of a Windows build: cargo registry, rustup toolchain and the checkout", () => {
    const found = findBuildMachinePaths(
      bytesOf(
        "C:\\Users\\someone\\.cargo\\registry\\src\\index.crates.io-1949cf8c6b5b557f\\las-0.10.0\\src\\lib.rs",
        "C:\\Users\\someone\\.rustup\\toolchains\\stable-x86_64-pc-windows-msvc\\lib/rustlib/src/rust/library/core/src/str/mod.rs",
        "C:\\workspace\\pcv-wt-CM-4\\vendor\\laz\\src\\las\\point0.rs",
      ),
    );
    expect(found.filter((path) => path.startsWith("C:\\"))).toHaveLength(3);
  });

  it("finds a drive path written with forward slashes and a lower-case drive letter", () => {
    expect(findBuildMachinePaths(bytesOf("d:/a/point-cloud-viewer/vendor/laz/src/lib.rs"))).toHaveLength(1);
  });

  it("finds the paths of a Linux CI build under /home/runner", () => {
    const found = findBuildMachinePaths(
      bytesOf(
        "/home/runner/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/las-0.10.0/src/lib.rs",
        "/home/runner/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/lib/rustlib/src/rust/library/core/src/str/mod.rs",
        "/home/runner/work/point-cloud-viewer/point-cloud-viewer/vendor/laz/src/las/point0.rs",
      ),
    );
    expect(found.filter((path) => path.startsWith("/home/runner/"))).toHaveLength(3);
  });

  it("finds a macOS home folder and a .cargo folder outside a home folder", () => {
    expect(findBuildMachinePaths(bytesOf("/Users/someone/src/pcv/crates/pcv-core/src/lib.rs"))).toHaveLength(1);
    expect(findBuildMachinePaths(bytesOf("/opt/.cargo/registry/src/x/lib.rs"))).toEqual([
      ".cargo/registry/src/x/lib.rs",
    ]);
  });

  it("finds a folder named after the user running the check in any case", () => {
    expect(findBuildMachinePaths(bytesOf("/srv/SOMEONE/pcv/lib.rs"), "someone")).toEqual(["/srv/SOMEONE/pcv/lib.rs"]);
  });

  it("does not take a user named like a remapped root for a path of the build machine", () => {
    const remapped = bytesOf("/pcv\\vendor\\laz\\src\\lib.rs", "/cargo\\registry\\src\\x\\lib.rs");
    expect(findBuildMachinePaths(remapped, "pcv")).toEqual([]);
    expect(findBuildMachinePaths(remapped, "cargo")).toEqual([]);
  });

  it("ignores a user name too short to tell apart from other text", () => {
    expect(findBuildMachinePaths(bytesOf("ab cd"), "ab")).toEqual([]);
  });

  it("does not count the tail of an http or https URL as a drive path", () => {
    expect(
      findBuildMachinePaths(
        bytesOf("http://laszip.orgCOPC", "http://www.w3.org/XML/1998/namespace", "https://example.com/a"),
      ),
    ).toEqual([]);
  });

  it("accepts the remapped paths that build:wasm writes", () => {
    expect(
      findBuildMachinePaths(
        bytesOf(
          "/cargo\\registry\\src\\index.crates.io-1949cf8c6b5b557f\\las-0.10.0\\src\\lib.rs",
          "/rustc-sysroot\\lib/rustlib/src/rust/library/core/src/str/mod.rs",
          "/pcv\\vendor\\laz\\src\\las\\point0.rs",
        ),
        "someone",
      ),
    ).toEqual([]);
  });
});

describe("build-wasm remapPathPrefixFlags", () => {
  it("remaps a Windows path with both drive letter cases and both separators", () => {
    expect(remapPathPrefixFlags([{ from: "C:\\work\\pcv", to: "/pcv" }])).toEqual([
      "--remap-path-prefix=C:\\work\\pcv=/pcv",
      "--remap-path-prefix=C:/work/pcv=/pcv",
      "--remap-path-prefix=c:\\work\\pcv=/pcv",
      "--remap-path-prefix=c:/work/pcv=/pcv",
    ]);
  });

  it("puts the remap flags after the flags already in CARGO_ENCODED_RUSTFLAGS", () => {
    expect(encodedRustflagsWith(["--remap"], { CARGO_ENCODED_RUSTFLAGS: "-C\x1ftarget-cpu=mvp" })).toBe(
      "-C\x1ftarget-cpu=mvp\x1f--remap",
    );
  });

  it("puts the remap flags after the flags already in RUSTFLAGS", () => {
    expect(encodedRustflagsWith(["--remap"], { RUSTFLAGS: " -C  opt-level=s " })).toBe("-C\x1fopt-level=s\x1f--remap");
  });

  it("passes only the remap flags when no flags are given", () => {
    expect(encodedRustflagsWith(["--a", "--b"], {})).toBe("--a\x1f--b");
  });

  it("remaps a Linux path as given", () => {
    expect(remapPathPrefixFlags([{ from: "/home/runner/.cargo", to: "/cargo" }])).toEqual([
      "--remap-path-prefix=/home/runner/.cargo=/cargo",
    ]);
  });
});

describe("audit CM-F2 R1 red", () => {
  it("does not take a user name found inside an ordinary word or a remapped path as a path of the build machine", () => {
    expect(findBuildMachinePaths(bytesOf("/rustc-sysroot/lib/rustlib/src/rust/library/core/src/str/mod.rs"), "root")).toEqual([]);
    expect(findBuildMachinePaths(bytesOf("/cargo/registry/src/x/roxmltree-0.21.1/src/tokenizer.rs"), "ken")).toEqual([]);
    expect(findBuildMachinePaths(bytesOf("copcfile_readNode"), "node")).toEqual([]);
  });

  it("still finds the user name as a folder of a path outside a home folder", () => {
    expect(findBuildMachinePaths(bytesOf("/srv/build/someone/pcv/vendor/laz/src/lib.rs"), "someone")).not.toEqual([]);
  });
});
