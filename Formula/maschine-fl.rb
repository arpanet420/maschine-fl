# Homebrew formula for mk3d (Maschine MK3 to FL Studio bridge).
#
#   brew tap arpanet420/maschine-fl https://github.com/arpanet420/maschine-fl
#   brew install --HEAD maschine-fl
#
# There is no tagged release yet, so only `head` exists. When a release is tagged, add above `head`:
#   url "https://github.com/arpanet420/maschine-fl/archive/refs/tags/vX.Y.Z.tar.gz"
#   sha256 "<shasum -a 256 of that tarball>"
# NOTE: written by hand against Homebrew's documented formula API and never run (Homebrew is not
# installed on the development machine). Try `brew install --HEAD --verbose maschine-fl` and `brew test`.
class MaschineFl < Formula
  desc "Use a Native Instruments Maschine MK3 as an FL Studio controller (mk3d daemon)"
  homepage "https://github.com/arpanet420/maschine-fl"
  head "https://github.com/arpanet420/maschine-fl.git", branch: "main"

  depends_on :macos
  depends_on "node"

  def install
    # Full install (the build needs TypeScript), compile to dist/, then drop the dev dependencies.
    # Everything stays inside the build directory; npm's cache goes to Homebrew's cache via std_npm_args.
    system "npm", "install", *std_npm_args(prefix: false), "--include=dev"
    system "npm", "run", "build"
    system "npm", "prune", "--omit=dev"

    libexec.install "bin", "dist", "docs", "fl-script", "node_modules", "package.json", "scripts"
    bin.install_symlink libexec/"bin/mk3d"
  end

  def caveats
    <<~EOS
      Next steps:
        1. mk3d setup --service
           (links the FL Studio script, starts mk3d at login and restarts it if it dies)
        2. In FL Studio: Options > MIDI Settings. Enable the "MK3 Bridge" input with controller
           type "MK3 Bridge" and a port number, and give the "MK3 Bridge FB" output the same number.
           `mk3d setup` prints the steps; mk3d must be running for the ports to show.

      NI's hardware agents are stopped while mk3d runs, so NI software cannot use the MK3 then.
      `mk3d stop --restore-ni` brings them back.

      Check the install with `mk3d doctor`. Remove it with `mk3d uninstall`, then `brew uninstall maschine-fl`.
    EOS
  end

  test do
    assert_match "Usage: mk3d", shell_output("#{bin}/mk3d help")
    assert_match "mk3d", shell_output("#{bin}/mk3d version")
  end
end
