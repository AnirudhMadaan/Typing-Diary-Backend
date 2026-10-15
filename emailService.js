import nodemailer from "nodemailer";

// In-memory OTP storage with TTL (10 minutes)
// Key: email.toLowerCase() -> { code, expiresAt, attempts }
const verificationStore = new Map();

// Periodic cleanup of expired codes
setInterval(() => {
  const now = Date.now();
  for (const [email, record] of verificationStore.entries()) {
    if (record.expiresAt < now) {
      verificationStore.delete(email);
    }
  }
}, 60 * 1000).unref();

/**
 * Check if real email credentials are configured in environment
 */
export function isEmailConfigured() {
  const hasGmail = Boolean(process.env.GMAIL_USER && (process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_PASS));
  const hasResend = Boolean(process.env.RESEND_API_KEY);
  const hasSmtp = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  return hasGmail || hasResend || hasSmtp;
}

/**
 * Create Nodemailer transporter if SMTP or Gmail is configured
 */
function getTransporter() {
  if (process.env.GMAIL_USER && (process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_PASS)) {
    return nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_PASS,
      },
    });
  }

  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === "true" || process.env.SMTP_PORT === "465",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  return null;
}

/**
 * Generate a 6-digit numeric OTP code
 */
export function generateVerificationCode(email) {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
  verificationStore.set(email.toLowerCase(), {
    code,
    expiresAt,
    attempts: 0,
  });
  return code;
}

/**
 * Verify a submitted code for an email
 */
export function verifyCode(email, submittedCode) {
  const cleanEmail = email.toLowerCase().trim();
  const record = verificationStore.get(cleanEmail);

  if (!record) {
    return { success: false, error: "No verification code requested or it has expired. Please request a new code." };
  }

  if (record.expiresAt < Date.now()) {
    verificationStore.delete(cleanEmail);
    return { success: false, error: "Verification code has expired. Please request a new code." };
  }

  record.attempts += 1;
  if (record.attempts > 5) {
    verificationStore.delete(cleanEmail);
    return { success: false, error: "Too many failed verification attempts. Please request a new code." };
  }

  if (record.code !== submittedCode.trim()) {
    return { success: false, error: "Incorrect verification code. Please check and try again." };
  }

  // Code verified! Remove from store
  verificationStore.delete(cleanEmail);
  return { success: true };
}

/**
 * Send verification email via configured provider (Resend, Gmail, or SMTP)
 */
export async function sendVerificationEmail({ to, name = "Writer", code }) {
  const fromAddress = process.env.EMAIL_FROM || process.env.GMAIL_USER || "Typing Diary <onboarding@resend.dev>";
  const subject = `Your Typing Diary verification code: ${code}`;

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Typing Diary Verification</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #FAF8F5; margin: 0; padding: 40px 20px; color: #24201C;">
  <div style="max-width: 520px; margin: 0 auto; background: #FFFFFF; border-radius: 16px; border: 1px solid #EAE4DC; padding: 36px 32px; box-shadow: 0 4px 16px rgba(0,0,0,0.04);">
    <div style="text-align: center; margin-bottom: 24px;">
      <h1 style="font-family: Georgia, serif; font-size: 26px; font-weight: bold; color: #2B2621; margin: 0 0 6px 0;">Typing Diary</h1>
      <p style="font-size: 13px; color: #8A7969; margin: 0; text-transform: uppercase; letter-spacing: 1px;">Email Verification</p>
    </div>
    
    <p style="font-size: 15px; line-height: 1.6; color: #4A3E33; margin: 0 0 20px 0;">
      Hello <strong>${name}</strong>,
    </p>
    <p style="font-size: 14px; line-height: 1.6; color: #4A3E33; margin: 0 0 24px 0;">
      Thank you for creating an account on Typing Diary. To complete your registration and protect your journal, please enter this 6-digit verification code:
    </p>
    
    <div style="background-color: #FAF4EB; border: 1px dashed #D8CABE; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px;">
      <span style="font-family: 'Courier New', Courier, monospace; font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #2B2621; display: inline-block;">
        ${code}
      </span>
    </div>
    
    <p style="font-size: 13px; line-height: 1.5; color: #736558; margin: 0 0 20px 0;">
      ⏱️ This verification code is valid for <strong>10 minutes</strong>.
    </p>
    
    <hr style="border: none; border-top: 1px solid #EFEAE2; margin: 24px 0;" />
    
    <p style="font-size: 11px; line-height: 1.5; color: #9E9285; margin: 0;">
      If you did not request this verification code, please ignore this email. No account will be created without this code.
    </p>
  </div>
</body>
</html>
  `.trim();

  // 1. Resend API support
  if (process.env.RESEND_API_KEY) {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromAddress,
          to: [to],
          subject,
          html: htmlContent,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.message || `Resend API failed with status ${response.status}`);
      }
      return { sent: true, provider: "resend" };
    } catch (error) {
      console.error("[EmailService] Resend delivery error:", error);
      throw error;
    }
  }

  // 2. Nodemailer (Gmail or Custom SMTP)
  const transporter = getTransporter();
  if (transporter) {
    try {
      await transporter.sendMail({
        from: fromAddress,
        to,
        subject,
        html: htmlContent,
      });
      return { sent: true, provider: "smtp" };
    } catch (error) {
      console.error("[EmailService] SMTP delivery error:", error);
      throw error;
    }
  }

  // 3. Fallback when credentials are not yet configured in .env
  console.log("------------------------------------------------------------------");
  console.log(`[EMAIL SERVICE] Verification code for ${to}: ${code}`);
  console.log(`[EMAIL SERVICE] Note: To deliver to real inboxes, configure GMAIL_USER/GMAIL_APP_PASSWORD, RESEND_API_KEY, or SMTP_HOST in backend/.env`);
  console.log("------------------------------------------------------------------");
  return { sent: false, devMode: true, code };
}
