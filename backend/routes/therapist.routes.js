const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const Patient = require('../models/Patient');
const Session = require('../models/Session');
const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/videos/');
  },
  filename: (req, file, cb) => {
    const suffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, suffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

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

    const newSession = new Session({
      therapistId: req.user.userId,
      title,
      exercises: exercises.map((ex, i) => {
        // Chercher si un fichier a été uploadé pour cet index
        const file = req.files.find(f => f.fieldname === `video_${i}`);
        return {
          title: ex.title,
          description: ex.description,
          duration: ex.duration,
          repetitions: ex.repetitions,
          videoPath: file ? `http://localhost:5000/uploads/videos/${file.filename}` : (ex.videoUrl || '')
        };
      })
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

    const updatedSession = await Session.findOneAndUpdate(
      { _id: req.params.id, therapistId: req.user.userId },
      {
        title,
        exercises: exercises.map((ex, i) => {
          const file = req.files.find(f => f.fieldname === `video_${i}`);
          return {
            title: ex.title,
            description: ex.description,
            duration: ex.duration,
            repetitions: ex.repetitions,
            videoPath: file ? `http://localhost:5000/uploads/videos/${file.filename}` : (ex.videoPath || ex.videoUrl || '')
          };
        })
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
