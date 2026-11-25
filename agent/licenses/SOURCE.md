# Corresponding source and build instructions

The Vantyr/voxl-linked agent binary is distributed under GPL-2.0 terms for the
combined work. The original Vantyr and voxl MIT notices remain applicable to their
source files. See GPL-2.0.txt and the individual notices in this directory.

Vantyr source (including the maintained voxl subset and build scripts):
https://github.com/gladsonsam/Vantyr

Select the release tag matching the installed agent version. Each release
provides GitHub's source archive. The codec fork is pinned to Tembo voxl commit
21f194f9e446e7073abd7bbd52e0b397c3800b42; its imported source and all Vantyr changes
are in agent/patches/voxl-codec, with build instructions in BUILD.md.

Windows releases also include a native-codec-sources archive containing vcpkg's
actual downloaded source archives and dependency version listing used for that
build. Build with the checked-in CI/release scripts and the listed vcpkg packages.
The original upstream native libraries are https://code.videolan.org/videolan/x264
and https://chromium.googlesource.com/libyuv/libyuv/ .

Linux dynamically links the distribution's x264/libyuv packages. The linked
versions and corresponding source are provided by that distribution's package
archive; native-codec-versions.txt in the release records the build versions.
