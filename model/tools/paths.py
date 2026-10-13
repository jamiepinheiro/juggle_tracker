"""Shared locations, so the model scripts work from any directory."""
import os

MODEL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(os.path.dirname(MODEL), "data_labelling", "data")  # labelled videos + built dataset
PRETRAINED = os.path.join(MODEL, "pretrained")  # stock Ultralytics weights, downloaded on first use
RUNS = os.path.join(MODEL, "runs")
