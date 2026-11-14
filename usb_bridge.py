#!/usr/bin/env python3
"""cue9 USB bridge: line protocol between the DSH plugin and the mote.

stdin  <- "ANIM <state>" / "AGENTS <n>" / "ALIVE" / "PING"
stdout -> one JSON object per line: status, serial line, error.
The bridge owns the serial port, retries if the board disappears, and keeps
working when the plugin is reloaded (the parent kills it on dispose).
"""
import argparse
import glob
import json
import os
import sys
import threading
import time

import serial


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def find_port():
    for pattern in ("/dev/cu.usbmodem*", "/dev/tty.usbmodem*"):
        ports = sorted(glob.glob(pattern))
        if ports:
            return ports[0]
    return None


class Bridge:
    def __init__(self, port):
        self.port = port
        self.ser = None
        self.stop = False
        self.connected = False
        self.last_error = None
        self.lock = threading.Lock()

    def open(self):
        port = None if self.port == "auto" else self.port
        while not self.stop:
            if port is None:
                port = find_port()
            if port is None:
                if self.connected or self.last_error != "no usbmodem":
                    self.connected = False
                    self.last_error = "no usbmodem"
                    emit({"type": "status", "connected": False, "port": None,
                          "error": self.last_error})
                time.sleep(1.0)
                continue
            try:
                self.ser = serial.Serial(port, 115200, timeout=0.2, write_timeout=1.0,
                                         dsrdtr=False, rtscts=False)
                # Do not hold the ESP32 EN/BOOT lines after opening.
                try:
                    self.ser.dtr = False
                    self.ser.rts = False
                except Exception:  # noqa: BLE001
                    pass
                self.connected = True
                self.last_error = None
                emit({"type": "status", "connected": True, "port": port})
                return
            except Exception as exc:  # noqa: BLE001
                self.ser = None
                self.connected = False
                self.last_error = str(exc)
                emit({"type": "status", "connected": False, "port": port,
                      "error": self.last_error})
                port = None
                time.sleep(1.5)

    def read_loop(self):
        while not self.stop:
            if self.ser is None:
                self.open()
                if self.ser is None:
                    continue
            try:
                raw = self.ser.readline()
                if raw:
                    line = raw.decode("utf-8", "replace").rstrip("\r\n")
                    if line:
                        emit({"type": "line", "line": line})
            except Exception as exc:  # noqa: BLE001
                self.last_error = str(exc)
                self.connected = False
                emit({"type": "status", "connected": False, "port": None,
                      "error": self.last_error})
                self.close_serial()
                self.ser = None
                time.sleep(1.0)

    def close_serial(self):
        try:
            if self.ser is not None:
                try:
                    self.ser.dtr = False
                    self.ser.rts = False
                except Exception:  # noqa: BLE001
                    pass
                self.ser.close()
        except Exception:  # noqa: BLE001
            pass
        self.ser = None
        self.connected = False

    def stdin_loop(self):
        for raw in sys.stdin:
            line = raw.strip()
            if not line:
                continue
            if not self.connected:
                emit({"type": "error", "error": "not connected", "line": line})
                continue
            try:
                with self.lock:
                    self.ser.write((line + "\n").encode("utf-8"))
                    self.ser.flush()
            except Exception as exc:  # noqa: BLE001
                emit({"type": "error", "error": str(exc), "line": line})

    def run(self):
        t = threading.Thread(target=self.read_loop, daemon=True)
        t.start()
        self.stdin_loop()
        self.stop = True
        self.close_serial()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default=os.environ.get("CUE9_PORT", "auto"))
    args = ap.parse_args()
    Bridge(args.port).run()


if __name__ == "__main__":
    main()
