# Mineradio English — Release Pipeline

## Two ways to release

### 1. GitHub Actions (automatic)

Push a version tag — Actions builds and publishes the release:

```bash
# version in package.json must match the tag (without the "v")
git add package.json
git commit -m "chore: bump version"
git push origin english
git tag vX.Y.Z-en.N
git push origin vX.Y.Z-en.N
```

- Workflow: `.github/workflows/release.yml` (windows-latest, Node 22, `npm ci`)
- On tags: `electron-builder --publish always` → non-draft release with Setup.exe + blockmap + latest.yml (~5–10 min)
- On manual runs (`workflow_dispatch`, Actions tab): build only; installer uploaded as workflow artifact

### 2. Local build

```bash
npx electron-builder --win nsis
gh release create vX.Y.Z-en.N dist/*-Setup.exe dist/*.blockmap dist/latest.yml --title "..." --notes "..."
```

## Notes

- `releaseType: "release"` in `build.publish` → tagged CI runs publish non-draft. Change to `"draft"` for review-before-publish.
- Auto-updater reads `latest.yml`; mirrors under `mineradio.update.mirrors` unaffected.
- Tag name must equal the `version` field with a `v` prefix.

---

## Upstream release process (kept for reference)

The sections below describe how upstream XxHuberrr/Mineradio ships releases (Chinese cloud-drive
distribution). The English fork does not follow this process; it is retained because merges from
`main` may touch this file.

- 正式版本：`2.1.0`；Git tag：`v2.1.0`
- 上游 Release 只附完整安装包，不附 latest.yml/blockmap；正文写入网盘线路。
- 网盘分发：夸克盘 <https://pan.quark.cn/s/f40289e1c5d3> · 百度云 <https://pan.baidu.com/s/14fgTABgbfseOg9QuX0Um7Q?pwd=sjhp>（提取码 `sjhp`）· 蓝奏云 <https://xxhuber.lanzout.com/mineradio2>
