# User Management — Adding Users to CAUCSim

How to give someone access to CAUCSim, and how to fix the things that commonly go
wrong afterwards. This is the *day-to-day* companion to
[AUTHSETUP.md](AUTHSETUP.md), which covers one-off creation of the Cognito User
Pool itself. Live resource IDs are recorded in [AWSCONFIG.md](AWSCONFIG.md).

---

## 1. How access works in this app

Read this before you touch the console — it explains why the steps below are
what they are.

* **There is no self-service sign-up.** The frontend
  (`frontend/cfd/js/main.js`) only ever calls Cognito's `InitiateAuth` and
  `RespondToAuthChallenge`. It never calls `SignUp`. A person can only get in if
  an administrator creates their account first.
* **Email is the sign-in identifier.** The pool is configured with email as the
  sign-in attribute, so the person signs in with their email address and a
  password.
* **Users can reset their own password.** The sign-in panel has a **Forgot
  password?** link that runs Cognito's `ForgotPassword` / `ConfirmForgotPassword`
  flow: the person receives a six-digit code by email and sets a new password
  themselves. This only works for accounts with a **verified email address** that
  have already completed their first sign-in — see
  [§7](#7-password-resets-and-lockouts) for the cases where an administrator
  still has to step in.
* **The app already handles the first-sign-in challenge.** When a newly invited
  user signs in with their temporary password, Cognito returns a
  `NEW_PASSWORD_REQUIRED` challenge, and the login panel swaps in a **New
  Password** field to complete it. This is the normal, expected first-run flow —
  no extra work is needed on your side.
* **Every account has the same privileges.** The backend
  (`backend/app/app.js`) verifies the Cognito **ID token** and then allows the
  request. There are no groups, roles, or per-user restrictions. *Adding a user
  grants full access to uploads, simulations, and results.*
* **The `email` attribute matters.** The backend reads the `email` claim from
  the ID token into `req.user.email`, so always set the email attribute on the
  account (§4/§5 do this).

---

## 2. Before you invite anyone: check email delivery

New users receive their temporary password by email, so email delivery has to be
working *before* you create the account. Check which mode the pool is in:

**Amazon Cognito console → User pools → your pool → Authentication methods →
Email configuration.**

| Mode | What it means for you |
| --- | --- |
| **Send email with Cognito** (default) | Capped at **50 emails per day, per AWS account**. This quota is **not adjustable** and resets daily at 09:00 UTC. Mail comes from `no-reply@verificationemail.com` and lands in spam fairly often. Fine for onboarding a handful of people; not fine for a cohort. |
| **Send email with Amazon SES** | Uses your own verified SES identity and SES sending limits. **Your AWS account must be out of the SES sandbox** — while it is in the sandbox, SES only delivers to addresses you have separately verified, so invitations to new users silently fail. |

Also confirm the invitation template still contains the password placeholder:

**Message templates → Invitation message.** The template **must** include the
`{####}` placeholder. If it is missing, Cognito does **not** send the invitation
at all — it just doesn't arrive. `{username}` is the other available placeholder.

---

## 3. Prerequisites for the administrator

* Access to the AWS account holding the pool, in region **`eu-west-2`**.
* The User Pool ID from [AWSCONFIG.md](AWSCONFIG.md) — currently
  `eu-west-2_ft1OVuuU1`.
* For the CLI route, IAM permission for the admin actions you intend to use:
  `cognito-idp:AdminCreateUser`, `AdminGetUser`, `ListUsers`,
  `AdminSetUserPassword`, `AdminUpdateUserAttributes`, `AdminDisableUser`,
  `AdminDeleteUser`. These operations are IAM-authorized — a signed-in app user's
  token cannot call them.

---

## 4. Adding a user — AWS Console

1. Open the [Amazon Cognito console](https://console.aws.amazon.com/cognito/home)
   and make sure the region selector reads **Europe (London) eu-west-2**.
2. Choose **User pools**, then the CAUCSim pool (`eu-west-2_ft1OVuuU1`).
3. Choose the **Users** menu, then **Create a user**.
4. Under **Invitation message**, choose **Send an email invitation**. (Choosing
   *Don't send an invitation* means you must deliver the temporary password
   yourself, out of band.)
5. Enter the person's **email address** as the sign-in value. Because this pool
   signs in by email, Cognito assigns an internal generated username (a UUID)
   behind the scenes — that is expected, and the email address remains the thing
   the person types on the login screen.
6. Under password, choose **Generate a password** so Cognito creates a
   policy-compliant temporary password and puts it in the invitation email.
   Choose **Create a password** only if you intend to communicate it yourself;
   it must satisfy the pool's password policy either way.
7. Choose **Create**.
8. Open the new user from the **Users** list and confirm:
   * **User status** is `Force change password` — correct for a fresh invite.
   * The **email** attribute is set, and **email_verified** is `true`. If it is
     `false`, edit the user attributes and set it to true (see the note in §6).

---

## 5. Adding a user — AWS CLI

Equivalent to §4, and easier to repeat. Note `--desired-delivery-mediums EMAIL`:
**the API default is `SMS`**, so omitting this flag means no email is sent.

```bash
aws cognito-idp admin-create-user \
  --region eu-west-2 \
  --user-pool-id eu-west-2_ft1OVuuU1 \
  --username 'new.person@example.com' \
  --user-attributes Name=email,Value='new.person@example.com' Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL
```

Omitting `--temporary-password` lets Cognito generate one and put it in the
invitation email — which is what you want. The response shows
`"UserStatus": "FORCE_CHANGE_PASSWORD"`.

To create the account without emailing anyone (for example, to hand the password
over in person), add `--message-action SUPPRESS` and your own
`--temporary-password '<value>'`.

Confirm afterwards:

```bash
aws cognito-idp admin-get-user \
  --region eu-west-2 \
  --user-pool-id eu-west-2_ft1OVuuU1 \
  --username 'new.person@example.com'
```

---

## 6. What the new user does

1. They receive the invitation email containing their username and temporary
   password. **Tell them to check their spam folder** — mail from
   `no-reply@verificationemail.com` is frequently filtered.
2. They open CAUCSim and enter their **email address** and the **temporary
   password**, then choose **Sign In**.
3. Cognito returns the `NEW_PASSWORD_REQUIRED` challenge, and the login panel
   reveals a **New Password** field ("Your temporary password has expired.
   Please set a new permanent password."). They enter a new password that meets
   the pool's password policy and submit.
4. The account status moves to `CONFIRMED` and they are signed in. Subsequent
   sign-ins use the new password directly.

> **On `email_verified`:** setting it to `true` at creation time (§4/§5) marks
> the address as trusted, which is what the `email` claim in the ID token — and
> therefore `req.user.email` in the backend — relies on. It is also what makes
> the **Forgot password?** link work: Cognito refuses `ForgotPassword` for an
> account with no verified email or phone number, so skipping this step means
> every future reset for that person lands on an administrator.

---

## 7. Password resets and lockouts

### The temporary password expired

Temporary passwords are valid for **7 days by default**
(`TemporaryPasswordValidityDays`, configurable from 1 to 365 days under
**Authentication methods → Password policy → Custom**). After expiry the person
can no longer sign in and needs a fresh invitation.

Re-send the invitation with a new temporary password and a reset clock:

```bash
aws cognito-idp admin-create-user \
  --region eu-west-2 \
  --user-pool-id eu-west-2_ft1OVuuU1 \
  --username 'new.person@example.com' \
  --desired-delivery-mediums EMAIL \
  --message-action RESEND
```

`RESEND` is the documented way to re-invite an existing user; the console does
not reliably expose a resend action for accounts stuck in
`FORCE_CHANGE_PASSWORD`, so prefer the CLI here.

### A confirmed user forgot their password

**Point them at the "Forgot password?" link on the sign-in panel first.** They
enter their email address, receive a six-digit code, and set a new password
without you. Codes expire after 24 hours, and the panel offers **Send a new
code** if one goes missing. Requirements for this to work:

* The account must have a **verified email address** (§6).
* The account must be `CONFIRMED` — someone still in `FORCE_CHANGE_PASSWORD` has
  never signed in, and Cognito rejects `ForgotPassword` for them with
  `NotAuthorizedException`. Re-invite them with `RESEND` instead (above).
* The pool's **account recovery** setting must allow self-service recovery by
  email (**Authentication methods → Account recovery**, "Enable self-service
  account recovery" with email as a delivery method).
* Reset codes come out of the same email allowance as invitations — on the
  default Cognito sender that is the shared **50 per day** (§2).

Administrator intervention is only needed when one of those doesn't hold. Set a
temporary password and put them back through the first-sign-in flow — the UI
they already know:

```bash
aws cognito-idp admin-set-user-password \
  --region eu-west-2 \
  --user-pool-id eu-west-2_ft1OVuuU1 \
  --username 'new.person@example.com' \
  --password '<temporary-value>' \
  --no-permanent
```

`--no-permanent` sets the status back to `FORCE_CHANGE_PASSWORD`, so they are
prompted for a new password at next sign-in. Using `--permanent` instead sets a
password they can sign in with immediately and marks them `CONFIRMED` — avoid it
unless you have a good reason, since it means you know their password.

**`admin-set-user-password` sends no email.** You have to communicate the value
yourself, over a channel the person already trusts.

---

## 8. Removing or suspending access

Disable first — it is reversible and keeps the account's history:

```bash
aws cognito-idp admin-disable-user \
  --region eu-west-2 --user-pool-id eu-west-2_ft1OVuuU1 \
  --username 'former.person@example.com'
```

(`admin-enable-user` reverses it.) Delete only when you are sure:

```bash
aws cognito-idp admin-delete-user \
  --region eu-west-2 --user-pool-id eu-west-2_ft1OVuuU1 \
  --username 'former.person@example.com'
```

Deletion is permanent. Note that neither action revokes an ID token that is
already issued — the disabled person keeps API access until their current token
expires.

Their uploaded CAD files and results remain in the S3 bucket
(`cauc-cfd-storage-bucket-247638741223-eu-west-2-an`) and must be removed
separately if that is required.

---

## 9. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| No invitation email arrives | The 50/day Cognito default quota is exhausted; or SES is still in the sandbox; or the invitation template is missing `{####}`, which suppresses sending entirely; or the message is in spam. |
| CLI created the user but no email was sent | `--desired-delivery-mediums` was omitted, so it defaulted to `SMS`. Re-send with `--message-action RESEND` and the flag set to `EMAIL`. |
| `An error occurred (UsernameExistsException)` | The account already exists. Use `--message-action RESEND` to re-invite rather than creating it again. |
| User reports "Incorrect username or password" on a brand new account | The temporary password has expired (default 7 days) — re-invite with `RESEND`. |
| New password rejected at the challenge step | It doesn't meet the pool's password policy (**Authentication methods → Password policy**). |
| "This account cannot reset its password this way" on the reset screen | The account is still in `FORCE_CHANGE_PASSWORD` (never signed in) or is disabled. Re-invite with `RESEND` rather than resetting. |
| "This account has no verified email address" on the reset screen | `email_verified` is `false` on the account. Set it to `true` (§4/§5), or reset the password for them. |
| Reset code never arrives | Same email-delivery causes as a missing invitation (row 1) — reset codes share the invitation allowance. |
| Sign-in succeeds but API calls return 401 | An ID-token problem rather than a user problem. Check that `COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID` in the Lambda environment match the pool the frontend is authenticating against. |

---

## 10. References

Verified against AWS documentation on 2026-09-02:

* [Creating user accounts as administrator](https://docs.aws.amazon.com/cognito/latest/developerguide/how-to-create-user-accounts.html)
* [`AdminCreateUser` API reference](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminCreateUser.html)
* [`admin-create-user` CLI reference](https://docs.aws.amazon.com/cli/latest/reference/cognito-idp/admin-create-user.html)
* [`AdminSetUserPassword` API reference](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminSetUserPassword.html)
* [Email settings for Amazon Cognito user pools](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html)
* [Quotas in Amazon Cognito](https://docs.aws.amazon.com/cognito/latest/developerguide/quotas.html)
* [`PasswordPolicyType` (temporary password validity)](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_PasswordPolicyType.html)
