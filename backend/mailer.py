import logging
import os
import smtplib
from email.message import EmailMessage

logger = logging.getLogger(__name__)


def send_reset_email(to: str, link: str) -> None:
    """Send the reset link over SMTP (Gmail: SMTP_USER + 16-char App Password)."""
    user = os.environ.get("SMTP_USER", "").strip()
    password = os.environ.get("SMTP_PASSWORD", "").replace(" ", "")
    if not user or not password:
        logger.warning("SMTP_USER/SMTP_PASSWORD not set; password reset email not sent")
        return
    msg = EmailMessage()
    msg["Subject"] = "Reset your password"
    msg["From"] = user
    msg["To"] = to
    msg.set_content(
        "Someone asked to reset the password for your account.\n\n"
        f"Open this link within 30 minutes to choose a new password:\n{link}\n\n"
        "If you did not ask for this, ignore this email; your password stays the same."
    )
    try:
        with smtplib.SMTP(os.environ.get("SMTP_HOST", "smtp.gmail.com"), int(os.environ.get("SMTP_PORT", "587")), timeout=20) as smtp:
            smtp.starttls()
            smtp.login(user, password)
            smtp.send_message(msg)
    except Exception:
        logger.exception("Failed to send password reset email")
