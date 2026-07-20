const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const bucketName = process.env.S3_BUCKET_NAME;
const region = process.env.AWS_REGION || 'eu-west-2';

async function run() {
  if (!bucketName) {
    console.error("ERROR: S3_BUCKET_NAME is not configured in .env. Cannot upload to S3.");
    process.exit(1);
  }

  const templateDir = path.join(__dirname, '../openfoam-template');
  if (!fs.existsSync(templateDir)) {
    console.error(`ERROR: Template directory not found at: ${templateDir}`);
    process.exit(1);
  }

  const zipPath = path.join(__dirname, '../case-template.zip');
  console.log(`Zipping openfoam-template to ${zipPath}...`);

  try {
    // Run zip command on the host (mac / linux)
    // We navigate to the template directory and zip its contents
    execSync(`zip -r "${zipPath}" .`, {
      cwd: templateDir,
      stdio: 'inherit'
    });
  } catch (err) {
    console.error("ERROR: Failed to zip template folder:", err.message);
    process.exit(1);
  }

  console.log(`Uploading ${zipPath} to S3 bucket ${bucketName} as case-template.zip...`);

  try {
    const s3Client = new S3Client({ region });
    const fileStream = fs.createReadStream(zipPath);
    const stats = fs.statSync(zipPath);

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: 'case-template.zip',
      Body: fileStream,
      ContentLength: stats.size,
      ContentType: 'application/zip'
    });

    await s3Client.send(command);
    console.log("SUCCESS: Uploaded case-template.zip to S3!");
  } catch (err) {
    console.error("ERROR: Failed to upload to S3:", err.message);
  } finally {
    // Cleanup local zip
    if (fs.existsSync(zipPath)) {
      console.log("Cleaning up local zip file...");
      fs.unlinkSync(zipPath);
    }
  }
}

run();
