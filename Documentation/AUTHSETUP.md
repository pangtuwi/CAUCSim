# AWS Cognito User Pool Setup Guide

This guide details the step-by-step process to configure an **AWS Cognito User Pool** to secure the CAUCSim application.

---

## Step 1: Create Cognito User Pool

1. Log in to the [AWS Management Console](https://console.aws.aws.amazon.com/).
2. Navigate to **Cognito** (search for "Cognito" in the top bar).
3. Click the **Create user pool** button.

---

## Step 2: Configure Sign-in Experience

1. Under **Provider type**, select **Cognito user pool**.
2. Under **Cognito user pool sign-in options**, check **Email** (users will log in using their email address).
3. Click **Next**.

---

## Step 3: Configure Security Requirements

1. **Password Policy**: Keep "Cognito defaults" or customize the length and character requirements.
2. **Multi-Factor Authentication (MFA)**:
   - Select **No MFA** if you want simple testing, or **Required MFA** for production security (recommended).
3. **User Account Recovery**:
   - Check **Enable self-service account recovery**.
   - Under **Delivery method for recovery messages**, select **Email only**.
4. Click **Next**.

---

## Step 4: Configure Sign-up Experience

1. Under **Self-service sign-up**, check **Enable self-service sign-up** if you want anyone to register.
   * *Security Tip:* Uncheck this if you only want the administrator to manually invite users to the simulation tool.
2. **Attribute Verification**:
   - Check **Allow Cognito to automatically send messages to verify attributes**.
   - Under **Attributes to verify**, select **Verify email address**.
3. Under **Required attributes**, verify that **email** is listed.
4. Click **Next**.

---

## Step 5: Configure Message Delivery

1. Under **Email provider**, select **Send email with Cognito** for development.
   * *Note:* Cognito has a low daily limit for testing. For production usage, select **Send email with Amazon SES** (requires setting up SES domain identities).
2. Click **Next**.

---

## Step 6: Integrate Application (App Client)

1. Enter a **User pool name** (e.g. `caucsim-user-pool`).
2. Under **Initial app client**, select **Public client** (this is critical since the client-side Three.js code cannot protect client secrets).
3. Enter an **App client name** (e.g. `caucsim-web-app`).
4. Under **Client secret**, select **Don't generate a client secret**.
5. Expand the **Authentication flows** dropdown settings and check **ALLOW_USER_PASSWORD_AUTH** (this enables direct HTTP sign-in from our vanilla frontend).
5. Click **Next**.

---

## Step 7: Review and Create

1. Review all your configurations.
2. Click **Create user pool**.

---

## Step 8: Configure Environment Variables

Once the User Pool is created, retrieve the following values from the Cognito console:

1. **User Pool ID**: Located at the top of your User Pool details page (e.g., `eu-west-2_aBcDeFg12`).
2. **App Client ID**: Click on the **App Integration** tab, scroll to the bottom under **App clients**, and copy the Client ID (e.g., `3n4b5v6c7x8z9q1w2e3r4t5y6u`).
3. **AWS Region**: The region code prefix of your User Pool ID (e.g., `eu-west-2`).

Create or update your `.env` file in the project root:

```env
# AWS Cognito configuration
COGNITO_USER_POOL_ID=eu-west-2_aBcDeFg12
COGNITO_CLIENT_ID=3n4b5v6c7x8z9q1w2e3r4t5y6u
AWS_REGION=eu-west-2
```
