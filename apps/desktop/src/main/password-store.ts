/**
 * Decides, on Linux, whether the app asks Chromium to keep the login token's
 * key in a Secret Service (GNOME Keyring, KeePassXC and the like).
 *
 * Chromium picks its password store from the desktop it recognises. It picks
 * a keyring for GNOME, Cinnamon, Deepin, Pantheon, UKUI, Unity, XFCE and
 * COSMIC, KWallet for KDE, and `basic_text`, whose key is public, for
 * everything else: a desktop it does not know, such as Hyprland, sway or i3,
 * and also LXQt and KDE 3. `basic_text` is also what it picks when the desktop
 * variables are missing, as in a session started by hand. A Secret Service
 * may be running all the same, and the user then gets no saved sign-in.
 *
 * The policy: the app asks for `gnome-libsecret` on every desktop that does
 * not look like KDE, and leaves KDE to Chromium, so KDE keeps KWallet. On the
 * desktops where Chromium picks a keyring that is the store it would have
 * picked anyway. A full port of Chromium's detection costs more bytes in
 * main's startup file than its budget allows (see spec 17, Performance), so
 * the check for KDE is looser than Chromium's: any sign of KDE makes the app
 * leave the choice to Chromium, which can at worst keep `basic_text` on KDE 3
 * and on a list that names LXQt before KDE, as Chromium does today.
 *
 * This module imports nothing, so unit tests can use it without Electron.
 */

/**
 * Checks whether `env` looks like a KDE desktop: `XDG_CURRENT_DESKTOP`
 * (names separated by colons) or `DESKTOP_SESSION` holds "kde" in any case,
 * or the `KDE_FULL_SESSION` variable is set. These are the variables Chromium
 * reads for KDE. The test is looser than Chromium's: a name that only
 * contains "kde" counts too.
 */
export const looksLikeKde = (env: Readonly<Record<string, string | undefined>>): boolean =>
  /kde/i.test(`${env["XDG_CURRENT_DESKTOP"]}:${env["DESKTOP_SESSION"]}`) ||
  env["KDE_FULL_SESSION"] !== undefined;
