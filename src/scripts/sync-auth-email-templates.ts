import "dotenv/config";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const accessToken = process.env.SUPABASE_ACCESS_TOKEN?.trim();
const configuredRef = process.env.SUPABASE_PROJECT_REF?.trim();
const urlRef = (() => {
  try {
    return new URL(process.env.SUPABASE_URL ?? "").hostname.split(".")[0];
  } catch {
    return "";
  }
})();
const projectRef = configuredRef || urlRef;

if (!accessToken || !projectRef) {
  throw new Error("Set SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF before syncing hosted auth email templates");
}

const templateDirectory = resolve(process.cwd(), "supabase/templates");
const template = (name: string) => readFile(resolve(templateDirectory, name), "utf8");

const [
  confirmation,
  invite,
  magicLink,
  recovery,
  emailChange,
  reauthentication,
  passwordChanged,
  emailChanged,
  phoneChanged,
  identityLinked,
  identityUnlinked,
  mfaEnrolled,
  mfaUnenrolled,
] = await Promise.all([
  template("confirmation.html"),
  template("invite.html"),
  template("magic_link.html"),
  template("recovery.html"),
  template("email_change.html"),
  template("reauthentication.html"),
  template("password_changed_notification.html"),
  template("email_changed_notification.html"),
  template("phone_changed_notification.html"),
  template("identity_linked_notification.html"),
  template("identity_unlinked_notification.html"),
  template("mfa_factor_enrolled_notification.html"),
  template("mfa_factor_unenrolled_notification.html"),
]);

const body = {
  mailer_subjects_confirmation: "Your MiRoadmap verification code",
  mailer_templates_confirmation_content: confirmation,
  mailer_subjects_invite: "You have been invited to MiRoadmap",
  mailer_templates_invite_content: invite,
  mailer_subjects_magic_link: "Your MiRoadmap verification code",
  mailer_templates_magic_link_content: magicLink,
  mailer_subjects_recovery: "Reset your MiRoadmap password",
  mailer_templates_recovery_content: recovery,
  mailer_subjects_email_change: "Confirm your new MiRoadmap email",
  mailer_templates_email_change_content: emailChange,
  mailer_subjects_reauthentication: "{{ .Token }} is your MiRoadmap verification code",
  mailer_templates_reauthentication_content: reauthentication,
  mailer_notifications_password_changed_enabled: true,
  mailer_subjects_password_changed_notification: "Your MiRoadmap password was changed",
  mailer_templates_password_changed_notification_content: passwordChanged,
  mailer_notifications_email_changed_enabled: true,
  mailer_subjects_email_changed_notification: "Your MiRoadmap email was changed",
  mailer_templates_email_changed_notification_content: emailChanged,
  mailer_notifications_phone_changed_enabled: true,
  mailer_subjects_phone_changed_notification: "Your MiRoadmap phone number was changed",
  mailer_templates_phone_changed_notification_content: phoneChanged,
  mailer_notifications_identity_linked_enabled: true,
  mailer_subjects_identity_linked_notification: "A sign-in method was added to your MiRoadmap account",
  mailer_templates_identity_linked_notification_content: identityLinked,
  mailer_notifications_identity_unlinked_enabled: true,
  mailer_subjects_identity_unlinked_notification: "A sign-in method was removed from your MiRoadmap account",
  mailer_templates_identity_unlinked_notification_content: identityUnlinked,
  mailer_notifications_mfa_factor_enrolled_enabled: true,
  mailer_subjects_mfa_factor_enrolled_notification: "A verification method was added to your MiRoadmap account",
  mailer_templates_mfa_factor_enrolled_notification_content: mfaEnrolled,
  mailer_notifications_mfa_factor_unenrolled_enabled: true,
  mailer_subjects_mfa_factor_unenrolled_notification: "A verification method was removed from your MiRoadmap account",
  mailer_templates_mfa_factor_unenrolled_notification_content: mfaUnenrolled,
};

const response = await fetch(`https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/config/auth`, {
  method: "PATCH",
  headers: {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});

if (!response.ok) {
  const detail = (await response.text()).slice(0, 1_000);
  throw new Error(`Supabase template sync failed (${response.status}): ${detail}`);
}

console.log(`Synced ${Object.keys(body).filter((key) => key.includes("templates_")).length} auth email templates to ${projectRef}`);
