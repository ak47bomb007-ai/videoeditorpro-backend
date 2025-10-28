// Video Processing Backend for VideoEditorPro
const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 10000;

// Enable CORS
app.use(cors());
app.use(express.json());

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = './uploads';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

// Create output directory
const outputDir = './output';
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        service: 'VideoEditorPro Backend',
        timestamp: new Date().toISOString()
    });
});

// Upload endpoint
app.post('/upload', upload.single('video'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No video file uploaded' });
        }

        console.log(`Video uploaded: ${req.file.filename}`);
        
        res.json({
            success: true,
            fileId: req.file.filename,
            message: 'Video uploaded successfully'
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed', details: error.message });
    }
});

// Process endpoint - combines two videos
app.post('/process', async (req, res) => {
    try {
        const { video1, video2, layout, audioOption = 'mixed' } = req.body;

        if (!video1 || !video2) {
            return res.status(400).json({ error: 'Both video1 and video2 are required' });
        }

        const video1Path = path.join('./uploads', video1);
        const video2Path = path.join('./uploads', video2);

        if (!fs.existsSync(video1Path) || !fs.existsSync(video2Path)) {
            return res.status(404).json({ error: 'One or both videos not found' });
        }

        const outputId = `${uuidv4()}.mp4`;
        const outputPath = path.join(outputDir, outputId);

        console.log(`Processing: ${video1} + ${video2}`);
        console.log(`Layout: ${layout}, Audio: ${audioOption}`);

        // Create FFmpeg command based on layout and audio option
        let ffmpegCommand;

        if (layout === 'sidebyside') {
            // Side by side layout with both audio tracks mixed
            ffmpegCommand = ffmpeg()
                .input(video1Path)
                .input(video2Path)
                .complexFilter([
                    '[0:v]scale=iw/2:ih[left]',
                    '[1:v]scale=iw/2:ih[right]',
                    '[left][right]hstack=inputs=2[v]',
                    '[0:a][1:a]amix=inputs=2:duration=shortest[a]'
                ])
                .outputOptions([
                    '-map [v]',
                    '-map [a]',
                    '-c:v libx264',
                    '-preset fast',
                    '-crf 23',
                    '-c:a aac',
                    '-b:a 128k'
                ])
                .output(outputPath);
        } else if (layout === 'stacked') {
            // Stacked (vertical) layout with both audio tracks mixed
            ffmpegCommand = ffmpeg()
                .input(video1Path)
                .input(video2Path)
                .complexFilter([
                    '[0:v]scale=iw:ih/2[top]',
                    '[1:v]scale=iw:ih/2[bottom]',
                    '[top][bottom]vstack=inputs=2[v]',
                    '[0:a][1:a]amix=inputs=2:duration=shortest[a]'
                ])
                .outputOptions([
                    '-map [v]',
                    '-map [a]',
                    '-c:v libx264',
                    '-preset fast',
                    '-crf 23',
                    '-c:a aac',
                    '-b:a 128k'
                ])
                .output(outputPath);
        } else {
            // Sequential (default)
            ffmpegCommand = ffmpeg()
                .input(video1Path)
                .input(video2Path)
                .complexFilter('[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]')
                .outputOptions([
                    '-map [v]',
                    '-map [a]',
                    '-c:v libx264',
                    '-preset fast',
                    '-crf 23',
                    '-c:a aac',
                    '-b:a 128k'
                ])
                .output(outputPath);
        }

        // Execute FFmpeg
        ffmpegCommand
            .on('start', (commandLine) => {
                console.log('FFmpeg started:', commandLine);
            })
            .on('progress', (progress) => {
                console.log(`Processing: ${progress.percent}% done`);
            })
            .on('end', () => {
                console.log(`Processing complete: ${outputId}`);
                res.json({
                    success: true,
                    outputId: outputId,
                    message: 'Videos processed successfully'
                });

                // Clean up input files after 5 minutes
                setTimeout(() => {
                    try {
                        if (fs.existsSync(video1Path)) fs.unlinkSync(video1Path);
                        if (fs.existsSync(video2Path)) fs.unlinkSync(video2Path);
                        console.log('Cleaned up input files');
                    } catch (err) {
                        console.error('Cleanup error:', err);
                    }
                }, 5 * 60 * 1000);
            })
            .on('error', (err) => {
                console.error('FFmpeg error:', err);
                res.status(500).json({ 
                    error: 'Processing failed', 
                    details: err.message 
                });
            })
            .run();

    } catch (error) {
        console.error('Process error:', error);
        res.status(500).json({ error: 'Processing failed', details: error.message });
    }
});

// Download endpoint
app.get('/download/:fileId', (req, res) => {
    try {
        const fileId = req.params.fileId;
        const filePath = path.join(outputDir, fileId);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found' });
        }

        console.log(`Downloading: ${fileId}`);

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${fileId}"`);

        const stream = fs.createReadStream(filePath);
        stream.pipe(res);

        stream.on('end', () => {
            // Clean up output file after 5 minutes
            setTimeout(() => {
                try {
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                        console.log('Cleaned up output file');
                    }
                } catch (err) {
                    console.error('Cleanup error:', err);
                }
            }, 5 * 60 * 1000);
        });

    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ error: 'Download failed', details: error.message });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 VideoEditorPro Backend running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing HTTP server');
    process.exit(0);
});
