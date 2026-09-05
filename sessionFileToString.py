import sqlite3
import struct
import base64
import sys
from pathlib import Path

# запуск из командной сторки: python sessionFileToString.py ./<sessionFileName>.session
def session_to_string(session_path: str) -> str:
    """
    Читает Telethon .session (SQLite) и возвращает GramJS-совместимый StringSession.

    Формат StringSession (GramJS):
      "1" + base64url( dcId[1] + ipLen[1] + ip[ipLen] + port[2] + authKey[256] )
    """
    path = Path(session_path)
    if not path.exists():
        raise FileNotFoundError(f"Файл не найден: {session_path}")

    conn = sqlite3.connect(str(path))
    try:
        row = conn.execute(
            "SELECT dc_id, server_address, port, auth_key FROM sessions LIMIT 1"
        ).fetchone()
    finally:
        conn.close()

    if row is None:
        raise ValueError("Таблица sessions пуста")

    dc_id, server_address, port, auth_key = row

    if isinstance(auth_key, str):
        auth_key = auth_key.encode("latin-1")

    ip_bytes = server_address.encode("utf-8")
    ip_len = len(ip_bytes)

    # Сборка бинарного буфера
    buf = struct.pack("B", dc_id)          # 1 байт: dc_id
    buf += struct.pack("B", ip_len)        # 1 байт: длина IP-строки
    buf += ip_bytes                        # N байт: IP как ASCII
    buf += struct.pack(">H", port)         # 2 байта: port big-endian
    buf += bytes(auth_key)                 # 256 байт: auth_key

    encoded = base64.urlsafe_b64encode(buf).decode("utf-8")
    return "1" + encoded


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Использование: python convert.py <path/to/account.session>")
        sys.exit(1)

    result = session_to_string(sys.argv[1])
    print(result)