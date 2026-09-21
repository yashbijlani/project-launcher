# Arch packaging (AUR)

`pacman` only installs from the official Arch repositories, which are controlled by
Arch developers. The user-publishable channel is the **AUR** (Arch User Repository):
you publish a `PKGBUILD`, and users install it with an AUR helper, which builds the
package and hands it to `pacman`.

```bash
paru -S project-launcher-git     # or: yay -S project-launcher-git
```

## Files

```text
packaging/aur/project-launcher-git/PKGBUILD   # VCS package tracking the GitHub repo
```

The package installs:

```text
/usr/bin/launcher                              # shell wrapper -> /usr/bin/node
/usr/lib/project-launcher-git/bin/launcher.js  # entrypoint
/usr/lib/project-launcher-git/dist/            # compiled TypeScript
/usr/lib/project-launcher-git/node_modules/    # production deps only (yaml)
/usr/share/licenses/project-launcher-git/LICENSE
/usr/share/doc/project-launcher-git/README.md
```

Runtime dependency: `nodejs`. Build dependency: `npm`.

## Build and test locally

`makepkg` must not run as root. Install the build prerequisites once:

```bash
sudo pacman -S --needed base-devel nodejs npm
```

Then build:

```bash
cd packaging/aur/project-launcher-git
makepkg -si          # build and install
launcher doctor      # verify the installed command
```

Regenerate the AUR metadata after editing the PKGBUILD:

```bash
makepkg --printsrcinfo > .SRCINFO
```

## Publish to the AUR

One-time setup:

1. Create an account at https://aur.archlinux.org
2. Add your SSH public key to the account profile (`My Account` -> SSH Public Key).
3. Ensure `~/.ssh/config` points `aur.archlinux.org` at that key (an `aur` key and
   config entry are already created in this environment).

Then:

```bash
git clone ssh://aur@aur.archlinux.org/project-launcher-git.git
cd project-launcher-git
cp /path/to/project-launcher/packaging/aur/project-launcher-git/PKGBUILD .
makepkg --printsrcinfo > .SRCINFO
git add PKGBUILD .SRCINFO
git commit -m "Initial import: project-launcher-git r<count>.<hash>"
git push
```

The first push creates the AUR package. Users can then install with
`paru -S project-launcher-git`.

## Notes

- This is a `-git` (VCS) package: it tracks the repository HEAD, so `pkgver()` is
  computed from the commit count and short hash, and no release tag is required.
- A stable `project-launcher` package pinned to a release tarball can be added later
  once a tagged release exists.
- `npm prune --omit=dev` runs in `build()` so `package()` needs no network and ships
  only the production dependency tree.
