//go:build linux

package cli

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

type e2eAssetBytes struct {
	runner, listener, worker, nodeArchive, node []byte
	filename, url, nodeURL, nodePath            string
}

func e2eDigest(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func e2ePlatformBytes(t *testing.T) (sharedPlatform, map[string]e2eAssetBytes) {
	t.Helper()
	c := platformFixture()
	assets := map[string]e2eAssetBytes{}
	for _, test := range []struct {
		arch, artifact string
		machine        uint16
	}{
		{"amd64", "x64", 62}, {"arm64", "arm64", 183},
	} {
		listener := append(syntheticELF(test.machine), []byte("listener")...)
		worker := append(syntheticELF(test.machine), []byte("worker")...)
		node := append(syntheticELF(test.machine), []byte("node")...)
		runner := platformArchiveFiles(t, map[string][]byte{
			"bin/Runner.Listener": listener, "bin/Runner.Worker": worker,
		})
		// Opaque synthetic Node archive bytes are selected, never unpacked or run.
		nodeArchive := append([]byte("synthetic-node-archive:"), node...)
		name := "actions-runner-linux-" + test.artifact + "-1.0.0.tar.gz"
		directory := "node-v1.2.3-linux-" + test.artifact
		assets[test.arch] = e2eAssetBytes{runner, listener, worker, nodeArchive, node,
			name, "https://github.com/actions/runner/releases/download/v1.0.0/" + name,
			"https://nodejs.org/dist/v1.2.3/" + directory + ".tar.xz",
			"/opt/nibfin/tools/" + directory + "/bin/node"}
		record := c.Targets[test.arch]
		record.RunnerHash, record.ListenerHash = e2eDigest(runner), e2eDigest(listener)
		record.WorkerHash = e2eDigest(worker)
		record.NodeArchiveHash, record.NodeHash = e2eDigest(nodeArchive), e2eDigest(node)
		c.Targets[test.arch] = record
	}
	return c, assets
}

func e2eSelectDesktopAssets(t *testing.T, arch string, api *fakeAPI,
	assets map[string]e2eAssetBytes) (sharedTarget, *e2eAPI, map[string]string) {
	t.Helper()
	observed := &e2eAPI{API: api}
	loaded, err := verifiedSharedPlatform(observed)
	if err != nil {
		t.Fatal(err)
	}
	kernel, machine := "x86_64", uint16(62)
	if arch == "arm64" {
		kernel, machine = "aarch64", 183
	}
	target, err := loaded.selectTarget(kernel, arch, machine)
	if err != nil {
		t.Fatal(err)
	}
	fixture := assets[arch]
	endpoint := "repos/actions/runner/releases/tags/v1.0.0"
	asset := map[string]string{"name": fixture.filename,
		"browser_download_url": fixture.url, "digest": "sha256:" + e2eDigest(fixture.runner)}
	api.data[endpoint] = map[string]any{"tag_name": "v1.0.0",
		"assets": []map[string]string{asset}}
	app, err := selectSharedRunner(observed, target)
	if err != nil {
		t.Fatal(err)
	}
	if target.Arch != arch || app.Filename != fixture.filename ||
		app.URL != fixture.url || app.Hash != e2eDigest(fixture.runner) ||
		target.ListenerHash != e2eDigest(fixture.listener) ||
		target.WorkerHash != e2eDigest(fixture.worker) ||
		target.NodeHash != e2eDigest(fixture.node) ||
		target.NodeArchiveHash != e2eDigest(fixture.nodeArchive) ||
		target.nodeURL() != fixture.nodeURL || target.nodePath() != fixture.nodePath {
		t.Fatal("asset identities diverged from fixture bytes", target, app)
	}
	if len(observed.calls) < 3 || observed.calls[len(observed.calls)-1].Path != endpoint {
		t.Fatal("official asset request not observed", observed.calls)
	}
	for _, call := range observed.calls {
		if call.Method != "GET" {
			t.Fatal("selection mutated provider", call)
		}
	}
	return target, observed, asset
}

func TestE2EDesktopAssets(t *testing.T) {
	for _, arch := range []string{"amd64", "arm64"} {
		t.Run(arch, func(t *testing.T) {
			c, assets := e2ePlatformBytes(t)
			api := initFixture()
			installSharedProducerFixture(t, api, c)
			target, observed, asset := e2eSelectDesktopAssets(t, arch, api, assets)
			fixture := assets[arch]
			// Real maintained file verification reads disposable caches; no success stub.
			root := t.TempDir()
			write := func(name string, data []byte) string {
				path := filepath.Join(root, name)
				if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, data, 0700); err != nil {
					t.Fatal(err)
				}
				return path
			}
			node := write("node", fixture.node)
			write("bin/Runner.Listener", fixture.listener)
			write("bin/Runner.Worker", fixture.worker)
			if err := verifySharedExecutableFile(node, target.NodeHash, target); err != nil {
				t.Fatal(err)
			}
			if err := verifySharedRunnerExecutables(root, target); err != nil {
				t.Fatal(err)
			}
			other := "arm64"
			if arch == other {
				other = "amd64"
			}
			wrong := assets[other]
			write("node", wrong.node)
			// Even a digest matching the wrong cache cannot waive ELF architecture.
			if verifySharedExecutableFile(node, e2eDigest(wrong.node), target) == nil {
				t.Fatal("wrong-architecture cache accepted")
			}
			write("bin/Runner.Worker", wrong.worker)
			if verifySharedRunnerExecutables(root, target) == nil {
				t.Fatal("wrong-architecture Runner cache accepted")
			}
			write("node", append(fixture.node, 'x'))
			if verifySharedExecutableFile(node, target.NodeHash, target) == nil {
				t.Fatal("changed executable digest accepted")
			}
			asset["digest"] = "sha256:" + e2eDigest(wrong.runner)
			if _, err := selectSharedRunner(observed, target); err == nil {
				t.Fatal("inconsistent official asset digest accepted")
			}
		})
	}
}

func TestE2EDesktopPlatformRejections(t *testing.T) {
	c, _ := e2ePlatformBytes(t)
	for _, test := range []struct {
		kernel, runtime string
		machine         uint16
	}{
		{"x86_64", "arm64", 62}, {"aarch64", "amd64", 183},
		{"aarch64", "arm64", 62}, {"x86_64", "amd64", 183},
		{"riscv64", "riscv64", 243},
	} {
		if _, err := c.selectTarget(test.kernel, test.runtime, test.machine); err == nil {
			t.Fatal("unsupported or contradictory native observations accepted", test)
		}
	}
	api := initFixture()
	installSharedProducerFixture(t, api, c)
	// Authentication must reject changed producer bytes before trusting the manifest.
	for path, data := range api.data {
		if bytes, ok := data.([]byte); ok && len(path) > 4 && path[len(path)-4:] == "/zip" {
			api.data[path] = append(append([]byte(nil), bytes...), 'x')
		}
	}
	if _, err := verifiedSharedPlatform(api); err == nil {
		t.Fatal("inconsistent producer digest accepted")
	}
}
