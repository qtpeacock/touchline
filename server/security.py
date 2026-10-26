"""Password hashing, session tokens and login throttling."""
import hashlib
import hmac
import os
import secrets
import time
from collections import defaultdict, deque

SCRYPT_N, SCRYPT_R, SCRYPT_P = 2**14, 8, 1


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt_hex, digest_hex = stored.split("$")
    except ValueError:
        return False
    if algo != "scrypt":
        return False
    digest = hashlib.scrypt(
        password.encode(), salt=bytes.fromhex(salt_hex), n=int(n), r=int(r), p=int(p), dklen=len(digest_hex) // 2
    )
    return hmac.compare_digest(digest.hex(), digest_hex)


# Checked when an email has no account, so a wrong email takes as long as a wrong password.
DUMMY_HASH = hash_password(secrets.token_hex(8))


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """Only token hashes are stored, so a leaked database cannot be replayed as live sessions."""
    return hashlib.sha256(token.encode()).hexdigest()


class LoginThrottle:
    """Blocks an email after too many failed logins inside a time window."""

    def __init__(self, limit: int = 5, window_seconds: int = 600):
        self.limit = limit
        self.window = window_seconds
        self.failures: dict[str, deque] = defaultdict(deque)

    def _recent(self, key: str) -> deque:
        attempts = self.failures[key]
        now = time.monotonic()
        while attempts and now - attempts[0] > self.window:
            attempts.popleft()
        return attempts

    def blocked(self, key: str) -> bool:
        return len(self._recent(key)) >= self.limit

    def fail(self, key: str) -> None:
        self._recent(key).append(time.monotonic())

    def reset(self, key: str) -> None:
        self.failures.pop(key, None)
