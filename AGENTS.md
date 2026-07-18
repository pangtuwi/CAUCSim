# CAUCSim - Agent Guidelines

Welcome to the CAUCSim repository. This document provides instructions and tips for agents working on this codebase.

## Project Overview
CAUCSim is a Node.js Express application deployed to AWS Lambda via `serverless-http`. It acts as a frontend for Computational Fluid Dynamics (CFD) aerodynamic simulations of Greenpower F24 vehicle designs.
The application utilizes a modern serverless direct-to-storage architecture, streaming binary CAD (STL) files directly from the browser to AWS S3.

## Environment and Fallback Mode
- The application relies on the `S3_BUCKET_NAME` environment variable to configure AWS S3 storage.
- **Local Disk Mock Mode:** If `S3_BUCKET_NAME` is not configured, the application automatically falls back to a 'Local Disk Mock Mode' for file uploads, storing files locally in an `uploads` directory.

## Testing Guidelines
- The project uses `jest` and `supertest` for testing.
- You can execute the test suite by running the `npm test` command.
- Always ensure that your changes pass existing tests and, if appropriate, add new tests for your features.

## Architecture Notes
- The application is event-driven and designed as a cloud-native serverless backend.
- It uses `@aws-sdk/s3-request-presigner` to generate presigned URLs for client-side direct uploads/downloads.
