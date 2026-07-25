const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
require('dotenv').config({ path: '/Users/paulwilliams/Documents/Programming/CAUCSim/.env' });

const bucketName = process.env.S3_BUCKET_NAME;
const region = process.env.AWS_REGION || 'eu-west-2';

async function run() {
  const s3Client = new S3Client({
    region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
  });

  const jobId = 'job-1784917295468-31d5b84f';
  const tempZip = '/Users/paulwilliams/Documents/Programming/CAUCSim/scratch/results.zip';
  const tempExtract = '/Users/paulwilliams/Documents/Programming/CAUCSim/scratch/extracted-results';

  try {
    console.log(`Downloading results.zip for job ${jobId}...`);
    const getCommand = new GetObjectCommand({
      Bucket: bucketName,
      Key: `results/${jobId}/results.zip`
    });
    const response = await s3Client.send(getCommand);
    const buffer = await response.Body.transformToByteArray();
    fs.writeFileSync(tempZip, buffer);

    console.log("Unzipping results...");
    if (fs.existsSync(tempExtract)) {
      fs.rmSync(tempExtract, { recursive: true, force: true });
    }
    fs.mkdirSync(tempExtract);
    execSync(`unzip -o "${tempZip}" -d "${tempExtract}"`);

    const vtkFile = path.join(tempExtract, 'postProcessing/cutPlane/50/yNormal.vtk');
    if (fs.existsSync(vtkFile)) {
      const content = fs.readFileSync(vtkFile, 'utf8');
      console.log("=== First 60 lines of yNormal.vtk ===");
      console.log(content.split('\n').slice(0, 60).join('\n'));
      
      console.log("=== Lines around POINT_DATA ===");
      const lines = content.split('\n');
      const pdIndex = lines.findIndex(line => line.includes('POINT_DATA'));
      if (pdIndex !== -1) {
        console.log(lines.slice(pdIndex, pdIndex + 40).join('\n'));
      }
    } else {
      console.log("yNormal.vtk not found!");
    }
  } catch (err) {
    console.error("Error:", err);
  } finally {
    if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip);
    if (fs.existsSync(tempExtract)) fs.rmSync(tempExtract, { recursive: true, force: true });
  }
}

run();
