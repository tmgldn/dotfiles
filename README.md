```bash
[ "${0##*/}" != "zsh" ] && echo "run in zsh instead!" && exit 1
rm -rf $HOME/README.md $HOME/.scripts $HOME/.dotfiles
git clone --bare https://github.com/tmgldn/dotfiles.git $HOME/.dotfiles
git --git-dir=$HOME/.dotfiles --work-tree=$HOME checkout main
source $HOME/.scripts/sync.zsh
```
