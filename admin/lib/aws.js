// Single S3 and Cognito client for the whole app. Both pick up credentials
// from the standard provider chain: AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY out
// of the repo-root .env locally, the execution role when running in Lambda.
const { S3Client } = require('@aws-sdk/client-s3');
const { CognitoIdentityProviderClient } = require('@aws-sdk/client-cognito-identity-provider');

const { region } = require('./config');

module.exports = {
  s3Client: new S3Client({ region }),
  cognitoClient: new CognitoIdentityProviderClient({ region })
};
