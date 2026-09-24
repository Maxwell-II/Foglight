"""Wave 3 A1: set the login credentials on an account.

    python scripts/create_user.py --email you@example.com

DEFAULT BEHAVIOUR IS TO UPGRADE THE EXISTING user_id=1, NOT TO CREATE ANYONE.
That is the whole point of this script (docs/work-packets-wave3.md 1.12a):

    Every reading session and every mark the owner has made since 2026-08-17
    hangs off user_id=1. Creating a fresh id=2 and logging into it turns all
    of that history into orphan rows that nothing can reach again -- and the
    symptom is "I logged in and everything is gone", which looks exactly like
    the resume-session bug fixed in Wave 2.5. Extremely hard to diagnose.

So: it prints which user_id it is about to touch, and how many reading
sessions and marks that user already owns, BEFORE writing anything. If that
count is 0 on your machine, stop -- you are almost certainly pointed at the
wrong database file (the path is printed too).

Only an explicit --new creates a second account.

The password is read with getpass, never from a command-line argument --
arguments end up in shell history and in `ps` output.

Console output is ASCII-only on purpose: this machine's terminal is GBK
(Wave 1 rule 4).
"""

from __future__ import annotations

import argparse
import getpass
import sys
from pathlib import Path

# The script lives at <repo>/scripts/, the package at <repo>/backend/app/.
# Bootstrapping the path here means it runs the same from the repo root, from
# backend/, or inside the container.
# 住在 backend/scripts/ 里：parent.parent 就是 backend/。
# ⚠️ 它必须在 backend/ 之下，不能放仓库根的 scripts/ —— 镜像的构建上下文是
#    backend/，Docker 不允许 COPY 上下文之外的路径，放外面就进不了镜像，
#    而部署手册第 2 步「容器里跑它建账号」就会 file not found。
_BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from sqlalchemy.orm import Session  # noqa: E402

from app.config import settings  # noqa: E402
from app.models import Mark, ReadingSession, User  # noqa: E402
from app.services.password import hash_password  # noqa: E402

MIN_PASSWORD_LEN = 8

# The owner's account. Deliberately a local constant, not a setting: since
# registration opened the app itself has no notion of a "default user" any more
# (the old config setting for it was removed); only this maintenance script does.
OWNER_USER_ID = 1


def _ascii(text: str) -> str:
    return text.encode("ascii", errors="backslashreplace").decode("ascii")


def owned_counts(session: Session, user_id: int) -> tuple[int, int]:
    """(reading sessions, marks) owned by this user. The 'am I on the right
    account' evidence -- marks are joined through reading_sessions because
    Mark has no user_id of its own."""
    sessions = session.query(ReadingSession).filter(ReadingSession.user_id == user_id).count()
    marks = (
        session.query(Mark)
        .join(ReadingSession, Mark.session_id == ReadingSession.id)
        .filter(ReadingSession.user_id == user_id)
        .count()
    )
    return sessions, marks


def _print_plan(session: Session, user: User | None, email: str, creating: bool) -> None:
    print(f"database : {_ascii(settings.database_url)}")
    if creating or user is None:
        print("action   : CREATE A NEW USER")
        print("target   : user_id=<new>   sessions=0   marks=0")
        print("           (existing history stays on user_id=1 and will NOT be visible")
        print("            to this new account -- that is almost never what you want)")
    else:
        sessions, marks = owned_counts(session, user.id)
        current_email = _ascii(user.email) if user.email else "<none>"
        has_pw = "yes" if user.password_hash else "no"
        print("action   : UPGRADE EXISTING USER (set email + password)")
        print(f"target   : user_id={user.id}   sessions={sessions}   marks={marks}")
        print(f"current  : email={current_email}   password_set={has_pw}")
        if sessions == 0 and marks == 0:
            print("WARNING  : this user owns no reading history. On the owner's machine")
            print("           user_id=1 should own 20+ sessions. Check the database path.")
    print(f"new email: {_ascii(email)}")
    print("           (failed_login_count and locked_until are reset to 0/None)")


def _read_password() -> str | None:
    first = getpass.getpass("New password: ")
    if len(first) < MIN_PASSWORD_LEN:
        print(f"password too short (need at least {MIN_PASSWORD_LEN} characters)")
        return None
    second = getpass.getpass("Repeat password: ")
    if first != second:
        print("passwords do not match")
        return None
    return first


def _confirm(assume_yes: bool) -> bool:
    if assume_yes:
        return True
    answer = input("proceed? type 'yes' to continue: ").strip().lower()
    return answer == "yes"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Set login credentials. Upgrades the existing user_id=1 by default."
    )
    parser.add_argument("--email", required=True, help="login email (stored lowercased)")
    parser.add_argument(
        "--new",
        action="store_true",
        help="create a NEW user instead of upgrading user_id=1 (rarely what you want)",
    )
    parser.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    args = parser.parse_args(argv)

    email = args.email.strip().lower()
    if "@" not in email or len(email) > 320:
        print("that does not look like an email address")
        return 2

    from app.db import SessionLocal  # deferred: only the CLI path touches the real DB

    session = SessionLocal()
    try:
        clash = session.query(User).filter(User.email == email).one_or_none()
        target = None if args.new else session.get(User, OWNER_USER_ID)

        if not args.new and target is None:
            print(f"user_id={OWNER_USER_ID} does not exist in this database.")
            print("nothing to upgrade. if you really want a fresh account, pass --new.")
            return 1

        if clash is not None and (args.new or target is None or clash.id != target.id):
            print(f"email already belongs to user_id={clash.id}. refusing.")
            return 1

        _print_plan(session, target, email, creating=args.new)
        if not _confirm(args.yes):
            print("aborted. nothing was written.")
            return 1

        password = _read_password()
        if password is None:
            print("aborted. nothing was written.")
            return 1

        if target is None:
            target = User()
            session.add(target)

        target.email = email
        target.password_hash = hash_password(password)
        # Legacy columns: login lockout moved to in-process memory keyed by
        # (email, IP) on 2026-09-24 and no longer reads these. Resetting them is
        # harmless; the recovery path out of a lockout is now waiting 15 minutes
        # or restarting the api container.
        target.failed_login_count = 0
        target.locked_until = None
        session.commit()
        session.refresh(target)

        print(f"done. user_id={target.id} can now log in as {_ascii(email)}")
        return 0
    finally:
        session.close()


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
        sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
    raise SystemExit(main())
