const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{
        .default_target = .{
            .cpu_arch = .wasm32,
            .os_tag = .wasi,
        },
    });
    const optimize = b.standardOptimizeOption(.{});

    const qjs_dir = b.path("../../wasm-deps/quickjs-2024-01-13");

    const mod = b.createModule(.{
        .root_source_file = b.path("src/full.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });

    mod.addIncludePath(qjs_dir);

    // Add QuickJS C sources to the module
    mod.addCSourceFiles(.{
        .root = qjs_dir,
        .files = &.{
            "quickjs.c",
            "libregexp.c",
            "libunicode.c",
            "libbf.c",
            "cutils.c",
        },
        .flags = &.{
            "-DCONFIG_VERSION=\"2024-01-13\"",
            "-DFE_DOWNWARD=1",
            "-DFE_UPWARD=2",
            "-DEMSCRIPTEN=1",
            "-Wno-error=implicit-int-float-conversion",
        },
    });

    // Add our C wrapper
    mod.addCSourceFiles(.{
        .root = b.path("src"),
        .files = &.{"qjs_engine.c"},
    });

    const full = b.addExecutable(.{
        .name = "kenkage-full",
        .root_module = mod,
    });
    full.entry = .disabled;
    full.root_module.strip = false;
    full.rdynamic = true;

    const install = b.addInstallArtifact(full, .{});
    b.getInstallStep().dependOn(&install.step);
}
