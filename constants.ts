export const API_URL = process.env.NODE_ENV === 'production' ? 'https://api.postbuddy.dk' : 'http://localhost:8000';
export const WEB_URL = process.env.NODE_ENV === 'production' ? 'https://app.postbuddy.dk' : 'http://localhost:3000';
export const config = {
  license: process.env.IMGLY_LICENSE,
  baseURL: "https://cdn.img.ly/packages/imgly/cesdk-node/1.28.0/assets",
}