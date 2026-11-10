import { config } from "../config.js";
import { sendMail } from "./mailer.js";
import { signTimed } from "./tokens.js";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const VERIFY_TTL_SEC = 24 * 60 * 60;

// Never throws: a mail problem must not break signup/login. The user can log in again to get a fresh link.
export async function sendVerifyMail({ id, email }) {
  const link = config.baseUrl + "/verify/" + signTimed("v", id, VERIFY_TTL_SEC);
  if (config.mailDriver !== "smtp") console.log("[verify] link for " + email + ": " + link);
  try {
    await sendMail({
      from: config.systemFrom,
      to: email,
      subject: "Confirm your email",
      text: "Confirm your email to activate your account:\n" + link + "\n\nThis link works for 24 hours. If you did not sign up, ignore this email.",
      html: "<p>Confirm your email to activate your account:</p><p><a href=\"" + esc(link) + "\">Confirm email</a></p><p style=\"color:#777;font-size:12px\">This link works for 24 hours. If you did not sign up, ignore this email.</p>",
    });
  } catch (e) {
    console.error("[verify] mail failed:", e.message);
  }
}
