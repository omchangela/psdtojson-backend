const express = require('express');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const { createCanvas, loadImage } = require('canvas');
const { readPsd, initializeCanvas } = require('ag-psd');

// Initialize canvas for PSD parsing
initializeCanvas(createCanvas, loadImage);

const app = express();
app.use(cors({
  origin: 'https://psdtojson-frontend.vercel.app',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '100mb' }));

// Configure directories
const uploadDir = path.join(__dirname, 'Uploads');
const fontsDir = path.join(__dirname, 'fonts');

// Ensure directories exist
const ensureDir = async (dir) => {
  try {
    await fs.mkdir(dir, { recursive: true });
    console.log(`Directory ensured: ${dir}`);
  } catch (err) {
    console.error(`Failed to create directory ${dir}:`, err.message);
  }
};

// Initialize directories
Promise.all([ensureDir(uploadDir), ensureDir(fontsDir)]).catch(err => {
  console.error('Failed to initialize directories:', err.message);
  process.exit(1);
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.psd') {
      cb(null, true);
    } else {
      cb(new Error('Only PSD files are allowed'));
    }
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({
    error: err.message || 'Internal Server Error',
    details: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

app.post('/upload', upload.single('psd'), async (req, res, next) => {
  try {
    if (!req.file) throw new Error('No file uploaded');

    const filePath = req.file.path;
    try {
      await fs.access(filePath);
    } catch {
      throw new Error('Uploaded file not found');
    }

    const buffer = await fs.readFile(filePath);
    if (!buffer.length) throw new Error('Empty file content');

    const psd = readPsd(buffer);
    if (!psd || !psd.width || !psd.height) throw new Error('Invalid PSD file');

    // Get filename without extension
    const fileName = path.parse(req.file.originalname).name;
    const skinsDir = path.join(__dirname, 'skins', fileName);
    await ensureDir(skinsDir);

    const { jsonOutput, images, fonts } = await createJsonOutput(psd, fileName, skinsDir);

    await fs.unlink(filePath).catch(err => console.warn('Failed to delete temp file:', err.message));

    res.json({ json: jsonOutput, images, fonts });
  } catch (err) {
    if (req.file?.path) {
      await fs.unlink(req.file.path).catch(err => console.error('Failed to delete temp file:', err.message));
    }
    next(err);
  }
});

async function createJsonOutput(psd, fileName, skinsDir) {
  const fonts = await extractFonts(psd.children || []);
  const images = [];
  const layers = await extractLayers(psd.children || [], fileName, skinsDir, images);
  const jsonOutput = {
    name: fileName,
    path: `${fileName}/`,
    info: {
      description: 'Normal',
      file: fileName,
      date: 'sRGB',
      title: '',
      author: '',
      keywords: '',
      generator: 'Export Kit v1.2.8'
    },
    layers
  };
  return { jsonOutput, images, fonts };
}

function rgbaToHex(rgba) {
  if (!rgba || rgba.length < 3) return null;
  const [r, g, b] = rgba;
  return `0x${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

async function extractFonts(layers) {
  const fonts = new Set();
  for (const layer of layers) {
    if (layer.text?.font?.name) {
      fonts.add(layer.text.font.name);
    }
    if (layer.children?.length > 0) {
      const childFonts = await extractFonts(layer.children);
      childFonts.forEach(font => fonts.add(font));
    }
  }
  return Array.from(fonts);
}

async function extractLayers(layers, fileName, skinsDir, images, imageCounter = { count: 0 }) {
  const result = [];

  for (const layer of layers) {
    const layerType = layer.children?.length > 0 ? 'group' : layer.text?.text ? 'text' : layer.canvas ? 'image' : 'other';
    const layerData = {
      type: layerType === 'text' ? 'text' : 'image',
      src: null,
      name: layer.name || `layer_${imageCounter.count}`,
      x: Number.isFinite(layer.left) ? layer.left : 0,
      y: Number.isFinite(layer.top) ? layer.top : 0,
      width: Math.max(0, (layer.right || 0) - (layer.left || 0)),
      height: Math.max(0, (layer.bottom || 0) - (layer.top || 0))
    };

    if (layerType === 'image' && layer.canvas) {
      const imageName = `${sanitizeFilename(layer.name || `image_${imageCounter.count}`)}.png`;
      const imagePath = path.join(skinsDir, imageName);
      layerData.src = `../skins/${fileName}/${imageName}`;

      try {
        const buffer = layer.canvas.toBuffer('image/png');
        await fs.writeFile(imagePath, buffer);
        images.push({ name: imageName, base64: `data:image/png;base64,${buffer.toString('base64')}` });
        imageCounter.count++;
      } catch (err) {
        console.error(`Failed to save image ${imageName}:`, err.message);
      }
    } else if (layerType === 'text' && layer.text) {
      if (layer.text.font?.name) layerData.font = layer.text.font.name;
      if (layer.text.alignment) layerData.justification = layer.text.alignment;
      if (layer.text.font?.colors?.[0]) layerData.color = rgbaToHex(layer.text.font.colors[0]);
      if (layer.text.font?.sizes?.[0]) layerData.size = layer.text.font.sizes[0];
      if (layer.text.text) layerData.text = layer.text.text;
    }

    if (layerData.type && (layerType !== 'image' || layerData.src)) result.push(layerData);

    if (layerType === 'group') {
      const childLayers = await extractLayers(layer.children, fileName, skinsDir, images, imageCounter);
      result.push(...childLayers);
    }
  }

  return result;
}

function sanitizeFilename(name) {
  return name ? name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase() : 'unnamed';
}

async function getFontFiles(fonts) {
  const fontFiles = [];
  try {
    const files = await fs.readdir(fontsDir);
    for (const font of fonts) {
      const fontFileName = `${sanitizeFilename(font)}.ttf`;
      const fontPath = path.join(fontsDir, fontFileName);
      if (files.includes(fontFileName)) {
        const buffer = await fs.readFile(fontPath);
        fontFiles.push({ name: fontFileName, data: buffer.toString('base64') });
      }
    }
  } catch (err) {
    console.error('Failed to read font files:', err.message);
  }
  return fontFiles;
}

app.post('/fonts', async (req, res, next) => {
  try {
    const { fonts } = req.body;
    if (!Array.isArray(fonts)) throw new Error('Invalid font list');
    const fontFiles = await getFontFiles(fonts);
    res.json(fontFiles);
  } catch (err) {
    next(err);
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Upload directory: ${uploadDir}`);
  console.log(`Fonts directory: ${fontsDir}`);
});