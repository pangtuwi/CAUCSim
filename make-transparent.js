// make-transparent.js
const sharp = require('sharp');

sharp('public/sandbach_high_dark.jpg')
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true })
  .then(({ data, info }) => {
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i+1];
      const b = data[i+2];
      
      const max = Math.max(r, g, b);
      
      if (max < 15) {
        data[i+3] = 0; // Transparent background
      } else if (max < 40) {
        // Smooth transition/feathering for clean anti-aliasing at the edges
        data[i+3] = Math.round(((max - 15) / (40 - 15)) * 255);
      } else {
        data[i+3] = 255; // Keep logo shapes fully opaque
      }
    }
    
    return sharp(data, {
      raw: {
        width: info.width,
        height: info.height,
        channels: 4
      }
    })
    .png()
    .toFile('public/sandbach_high_dark.png');
  })
  .then(() => {
    console.log("SUCCESS: Transparent PNG created!");
  })
  .catch(err => {
    console.error("ERROR:", err);
  });
