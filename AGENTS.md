# Agent Guidelines & Reference - CAUCSim

Welcome! This file outlines the technical stack, architectural patterns, and testing protocols for AI coding agents working on the CAUCSim codebase.

---

## 1. Core Architecture
- **Serverless Hybrid Execution:** Designed to run locally for development or deployable as an AWS Lambda function (wrapped with `serverless-http`).
- **Direct-to-Storage Uploads:** CAD files (STL format) are streamed directly from the frontend to AWS S3 using presigned URLs generated on the backend. The Express server never parses or buffers binary CAD file payloads.
- **Local Fallback (Mock S3):** If `S3_BUCKET_NAME` is not configured, the app runs in **Local Disk Mock Mode**, writing files to a local `uploads/` folder and serving them via Express static endpoints.

---

## 2. Authentication Flow
- **Cognito User Pools:** In production, authentication uses AWS Cognito User Pools with the `USER_PASSWORD_AUTH` flow called directly from the client.
- **JWT Verification:** The backend uses `aws-jwt-verify` to validate RS256 ID tokens on all data routes.
- **Developer Bypass (Mock Auth):** If `COGNITO_USER_POOL_ID` is missing, the backend runs in **Mock Auth Mode**, accepting a token value of `'mock-session-token'`. The frontend displays a "Bypass Login" button allowing developers to log in instantly.
- **Direct S3 Upload Exemption:** The `Authorization` header must NOT be attached to the direct S3 PUT request, as S3 signatures will fail if custom authorization headers are present. Only inject the token for local mock uploads.

---

## 3. Coordinate System & Geometry Mathematics
- **Z-Up Convention:** Three.js is configured with a Z-up coordinate system (`camera.up.set(0, 0, 1)`). Ensure all coordinate references and translations align with this.
- **Ground Snapping:** The ground grid snaps to the lowest Z vertex of the model.
- **Frontal Area Calculation:** Uses a 2D grid rasterizer on the Y-Z plane. Keep this fast and lightweight (computations under 15ms).
- **Volume and Surface Area:** Keep calculations purely client-side. Surface area is computed by summing triangle cross products. Volume uses watertight signed tetrahedron math.

---

## 4. Testing Protocols
- **Jest/Supertest:** Local API tests are stored in `app.test.js`.
- **Forced Mock Mode:** The test suite programmatically overrides environment variables to force local storage and mock auth:
  ```javascript
  process.env.S3_BUCKET_NAME = '';
  process.env.COGNITO_USER_POOL_ID = '';
  process.env.COGNITO_CLIENT_ID = '';
  ```
- **Execution:** Run tests using `npm test`. Ensure all tests pass before making pull requests.
