package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"fmt"
	"os"
	"runtime"

	cli "github.com/taco3064/gh-nibfin/internal/cli"
)

// Synthetic bytes are consumed only by the injected host, never executed.
func packageInput() ([]byte, cli.RunnerApplication) {
	var archive bytes.Buffer
	compressed := gzip.NewWriter(&archive)
	writer := tar.NewWriter(compressed)
	body := []byte("controlled non-executable Runner input")
	_ = writer.WriteHeader(&tar.Header{Name: "bin/Runner.Listener",
		Mode: 0700, Typeflag: tar.TypeReg, Size: int64(len(body))})
	_, _ = writer.Write(body)
	_ = writer.Close()
	_ = compressed.Close()
	arch := map[string]string{"amd64": "x64", "arm64": "arm64"}[runtime.GOARCH]
	filename := "actions-runner-linux-" + arch + "-1.0.0.tar.gz"
	application := cli.RunnerApplication{OS: "linux", Arch: arch,
		Filename: filename, Hash: fmt.Sprintf("%x", sha256.Sum256(archive.Bytes())),
		URL: "https://github.com/actions/runner/releases/download/v1.0.0/" + filename}
	return archive.Bytes(), application
}

func controlledApp(p *provider) cli.App {
	data, application := packageInput()
	p.application = application
	p.runners = []cli.RunnerInfo{}
	p.admin = true
	return cli.App{API: p, Runner: p, Process: p,
		Download: func(_ cli.RunnerApplication, path string) error {
			return os.WriteFile(path, data, 0600)
		}}
}
