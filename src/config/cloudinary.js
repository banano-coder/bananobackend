const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

console.log('☁️ Cloudinary Config Check:', {
  hasName: !!process.env.CLOUDINARY_CLOUD_NAME,
  hasKey: !!process.env.CLOUDINARY_API_KEY,
  hasSecret: !!process.env.CLOUDINARY_API_SECRET,
  cloudName: process.env.CLOUDINARY_CLOUD_NAME
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'banano_products',
    allowed_formats: ['jpg', 'png', 'jpeg', 'webp', 'gif'],
    public_id: (req, file) => {
        const id = req.params.id;
        return `p${id}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    },
  },
});

module.exports = { cloudinary, storage };
