# KyoubeAI: what people install from the Terminal comes first, in every login
# shell. /etc/profile has just reset PATH; the image's ENV PATH puts the same
# directory first for the server and every agent run.
case ":$PATH:" in
  *":/kyoubeai/.local/bin:"*) ;;
  *) PATH="/kyoubeai/.local/bin:$PATH"; export PATH ;;
esac
# Installers append their PATH lines to ~/.bashrc, which a login shell never
# reads unless ~/.profile sources it. Until someone writes their own profile,
# read it here, in interactive bash only.
case "$-" in
  *i*)
    if [ -n "${BASH_VERSION-}" ] && [ -r "$HOME/.bashrc" ] \
      && [ ! -e "$HOME/.bash_profile" ] && [ ! -e "$HOME/.bash_login" ] && [ ! -e "$HOME/.profile" ]; then
      # shellcheck disable=SC1091
      . "$HOME/.bashrc"
    fi
    ;;
esac
