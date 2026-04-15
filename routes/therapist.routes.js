// ...existing code...
// Route pour servir une vidéo depuis GridFS
router.get('/video/:id', async (req, res) => {
  try {
    const { initGridFS } = require('../models/gridfs');
    const mongoose = require('mongoose');
    const gfs = initGridFS(mongoose.connection);
    const { ObjectId } = require('mongodb');
    const fileId = new ObjectId(req.params.id);
    const files = await mongoose.connection.db.collection('videos.files').find({ _id: fileId }).toArray();
    if (!files || files.length === 0) {
      return res.status(404).json({ message: 'Vidéo non trouvée' });
    }
    res.set('Content-Type', files[0].contentType || 'video/mp4');
    const downloadStream = gfs.openDownloadStream(fileId);
    downloadStream.pipe(res);
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const Patient = require('../models/Patient');
const Session = require('../models/Session');

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const { initGridFS } = require('../models/gridfs');
const mongoose = require('mongoose');

router.use(auth(['therapist']));

router.get('/patients', async (req, res) => {
  try {
    const patients = await Patient.find().select('-password').lean();
    const PatientSession = require('../models/PatientSession');
    
    // Add completedSession count for each patient
    const enrichedPatients = await Promise.all(patients.map(async (p) => {
      const completedCount = await PatientSession.countDocuments({ patientId: p._id, status: 'completed' });
      return { ...p, completedCount };
    }));

    res.json(enrichedPatients);
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});

// Route de création de séance pour TOUS les patients (pas de patientId)
router.post('/sessions', upload.any(), async (req, res) => {
  try {
    const { title, exercisesData } = req.body;
    let exercises = [];
    if (exercisesData) {
      exercises = JSON.parse(exercisesData);
    }

    // Init GridFS bucket
    const gfs = initGridFS(mongoose.connection);

    // Upload videos to GridFS and get their ids
    const exercisePromises = exercises.map(async (ex, i) => {
      const file = req.files.find(f => f.fieldname === `video_${i}`);
      let videoId = null;
      if (file) {
        // Store in GridFS
        const uploadStream = gfs.openUploadStream(file.originalname, {
          contentType: file.mimetype
        });
        uploadStream.end(file.buffer);
        await new Promise((resolve, reject) => {
          uploadStream.on('finish', resolve);
          uploadStream.on('error', reject);
        });
        videoId = uploadStream.id;
      }
      return {
        title: ex.title,
        description: ex.description,
        duration: ex.duration,
        repetitions: ex.repetitions,
        videoPath: videoId ? `/api/therapist/video/${videoId}` : (ex.videoUrl || '')
      };
    });

    const exercisesWithVideos = await Promise.all(exercisePromises);

    const newSession = new Session({
      therapistId: req.user.userId,
      title,
      exercises: exercisesWithVideos
    });

    await newSession.save();
    res.status(201).json(newSession);
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});

// Récupérer les séances globales (créées par ce thérapeute)
router.get('/sessions', async (req, res) => {
  try {
    const sessions = await Session.find({ therapistId: req.user.userId });
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});

// Supprimer une séance
router.delete('/sessions/:id', async (req, res) => {
  try {
    const session = await Session.findOneAndDelete({ _id: req.params.id, therapistId: req.user.userId });
    if (!session) return res.status(404).json({ message: 'Séance non trouvée' });
    res.json({ message: 'Séance supprimée' });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});

// Modifier une séance (Metadata + Exercices)
router.put('/sessions/:id', upload.any(), async (req, res) => {
  try {
    const { title, exercisesData } = req.body;
    let exercises = [];
    if (exercisesData) {
      exercises = JSON.parse(exercisesData);
    }

    const gfs = initGridFS(mongoose.connection);

    const exercisePromises = exercises.map(async (ex, i) => {
      const file = req.files.find(f => f.fieldname === `video_${i}`);
      let videoId = null;
      if (file) {
        const uploadStream = gfs.openUploadStream(file.originalname, {
          contentType: file.mimetype
        });
        uploadStream.end(file.buffer);
        await new Promise((resolve, reject) => {
          uploadStream.on('finish', resolve);
          uploadStream.on('error', reject);
        });
        videoId = uploadStream.id;
      }
      return {
        title: ex.title,
        description: ex.description,
        duration: ex.duration,
        repetitions: ex.repetitions,
        videoPath: videoId ? `/api/therapist/video/${videoId}` : (ex.videoPath || ex.videoUrl || '')
      };
    });

    const exercisesWithVideos = await Promise.all(exercisePromises);

    const updatedSession = await Session.findOneAndUpdate(
      { _id: req.params.id, therapistId: req.user.userId },
      {
        title,
        exercises: exercisesWithVideos
      },
      { new: true }
    );

    if (!updatedSession) return res.status(404).json({ message: 'Séance non trouvée' });
    res.json(updatedSession);
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
});

module.exports = router;
