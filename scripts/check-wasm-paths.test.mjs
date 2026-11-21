// @vitest-environment node
import { describe, expect, it } from "vitest";
import { findBuildMachinePaths } from "./check-wasm-paths.mjs";
import { remapPathPrefixFlags } from "./build-wasm.mjs";

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

  it("finds the name of the user running the check in any case", () => {
    expect(findBuildMachinePaths(bytesOf("built by SOMEONE here"), "someone")).toEqual(["SOMEONE"]);
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

  it("remaps a Linux path as given", () => {
    expect(remapPathPrefixFlags([{ from: "/home/runner/.cargo", to: "/cargo" }])).toEqual([
      "--remap-path-prefix=/home/runner/.cargo=/cargo",
    ]);
  });
});
