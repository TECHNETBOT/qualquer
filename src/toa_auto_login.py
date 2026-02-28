#!/usr/bin/env python3
"""Abre o TOA no navegador padrão/Chrome sem depender de selenium.

Objetivo: iniciar Chrome no TOA para o operador logar manualmente.
"""

import os
import platform
import subprocess
import sys
import webbrowser

BOT_BUILD = os.getenv("BOT_BUILD", "v27")
TOA_URL = os.getenv("TOA_URL", "https://clarobrasil.etadirect.com/")


def log(msg: str):
    print(f"[{BOT_BUILD}] {msg}")


def open_on_windows(url: str) -> bool:
    commands = [
        ["cmd", "/c", "start", "", "chrome", url],
        ["powershell", "-NoProfile", "-Command", f"Start-Process chrome '{url}'"],
        ["cmd", "/c", "start", "", url],
    ]
    for cmd in commands:
        try:
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True
        except Exception:
            continue
    return False


def open_on_linux(url: str) -> bool:
    commands = [
        ["google-chrome", url],
        ["chromium-browser", url],
        ["chromium", url],
        ["powershell.exe", "-NoProfile", "-Command", f"Start-Process chrome '{url}'"] ,
        ["cmd.exe", "/c", "start", "", "chrome", url],
        ["xdg-open", url],
    ]
    for cmd in commands:
        try:
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True
        except Exception:
            continue
    return False


def open_on_macos(url: str) -> bool:
    commands = [
        ["open", "-a", "Google Chrome", url],
        ["open", url],
    ]
    for cmd in commands:
        try:
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True
        except Exception:
            continue
    return False


def main() -> int:
    system = platform.system().lower()
    opened = False

    if "windows" in system:
        opened = open_on_windows(TOA_URL)
    elif "darwin" in system:
        opened = open_on_macos(TOA_URL)
    else:
        opened = open_on_linux(TOA_URL)

    if not opened:
        try:
            opened = webbrowser.open(TOA_URL, new=2)
        except Exception:
            opened = False

    if opened:
        log(f"TOA aberto em navegador: {TOA_URL}")
        log("faça login manualmente; o bot seguirá apenas com as pesquisas")
        return 0

    log(f"não consegui abrir navegador automaticamente para {TOA_URL}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
