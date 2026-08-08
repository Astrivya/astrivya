# typed: false
# frozen_string_literal: true

# Astrivya CLI — local knowledge graph engine for AI coding agents
# Homebrew formula (stub — requires npm package to be published first)
#
# Install: brew install astrivya/astrivya/astrivya
# Tap:     brew tap astrivya/astrivya

class Astrivya < Formula
  desc "Local knowledge graph engine for AI coding agents"
  homepage "https://github.com/astrivya/astrivya"
  license "Apache-2.0"
  version "0.1.0"

  # TODO: Replace with actual URL and checksum after first npm publish
  # url "https://registry.npmjs.org/@astrivya/cli/-/cli-0.1.0.tgz"
  # sha256 "..."
  #
  # This is a stub formula. Run `brew create` with the npm tarball URL
  # to generate the correct SHA, then update this file.

  depends_on "node"

  def install
    system "npm", "install", "-g", "@astrivya/cli@#{version}"
    bin.install_symlink Dir["#{HOMEBREW_PREFIX}/lib/node_modules/@astrivya/cli/dist/index.js"]
  end

  test do
    assert_match "astrivya", shell_output("#{bin}/astrivya --version")
  end
end
