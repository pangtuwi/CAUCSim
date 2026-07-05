const express = require('express');
const serverless = require('serverless-http');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Hello World');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});


// Export the wrapped handler
module.exports.handler = serverless(app);