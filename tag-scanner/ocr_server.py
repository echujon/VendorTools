import os
import tempfile
import base64
from flask import Flask, request, jsonify, send_from_directory
from PIL import Image, ImageOps, ImageFilter
import numpy as np

try:
    from paddleocr import PaddleOCR
except ImportError as exc:
    raise RuntimeError(
        "PaddleOCR is not installed. Run `pip install -r requirements.txt`."
    ) from exc

try:
    import google.generativeai as genai
except ImportError:
    genai = None

app = Flask(__name__, static_folder=None)
ocr = PaddleOCR(use_angle_cls=True, lang="en")

# Initialize Gemini if API key is available
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
if GEMINI_API_KEY and genai:
    genai.configure(api_key=GEMINI_API_KEY)

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = APP_DIR

@app.route("/api/status", methods=["GET"])
def status():
    return jsonify({
        "gemini_key_set": bool(GEMINI_API_KEY),
        "gemini_available": bool(genai),
    })

@app.route("/", methods=["GET"])
def index():
    return send_from_directory(STATIC_DIR, "index.html")

def preprocess_image(path):
    img = Image.open(path).convert("L")
    img = ImageOps.autocontrast(img)
    img = img.filter(ImageFilter.SHARPEN)
    img = img.resize((img.width * 2, img.height * 2))
    arr = np.array(img)
    arr = np.where(arr > 180, 255, arr)
    arr = np.where(arr < 80, 0, arr)
    img = Image.fromarray(arr).convert("RGB")
    return img


@app.route("/api/ocr", methods=["POST"])
def ocr_image():
    if "image" not in request.files:
        return jsonify({"error": "missing image file"}), 400

    image_file = request.files["image"]
    use_gemini = request.args.get("engine") != "paddle" and GEMINI_API_KEY and genai
    
    extension = os.path.splitext(image_file.filename)[1] or ".jpg"

    with tempfile.NamedTemporaryFile(suffix=extension, delete=False) as tmp:
        temp_path = tmp.name
        image_file.save(temp_path)

    try:
        if use_gemini:
            return ocr_with_gemini(temp_path)
        else:
            return ocr_with_paddle(temp_path)
    finally:
        try:
            os.remove(temp_path)
        except OSError:
            pass


def ocr_with_gemini(image_path):
    try:
        with open(image_path, "rb") as f:
            image_data = base64.standard_b64encode(f.read()).decode("utf-8")

        model = genai.GenerativeModel("gemini-2.0-flash")
        prompt = "Extract all visible text from this image. Return only the text, line by line. Be accurate with handwriting."

        print(f"[Gemini] Sending image to Gemini: {image_path}")
        message = model.generate_content([
            {
                "mime_type": "image/jpeg",
                "data": image_data,
            },
            prompt
        ])

        text = message.text if message.text else ""
        print(f"[Gemini] Response: {repr(text)}")
        lines = [
            {
                "text": line.strip(),
                "confidence": 0.95,
                "box": [[0, 0], [1, 0], [1, 1], [0, 1]],
            }
            for line in text.split("\n") if line.strip()
        ]
        return jsonify({"lines": lines})
    except Exception as err:
        return jsonify({"error": f"Gemini OCR failed: {str(err)}"}), 500


def ocr_with_paddle(image_path):
    preprocessed = preprocess_image(image_path)
    preprocessed_path = image_path + ".preprocessed.jpg"
    preprocessed.save(preprocessed_path)
    
    try:
        result = ocr.ocr(preprocessed_path, cls=True)
        lines = [
            {
                "text": line[1][0],
                "confidence": float(line[1][1]),
                "box": line[0],
            }
            for line in result
        ]
        return jsonify({"lines": lines})
    finally:
        try:
            os.remove(preprocessed_path)
        except OSError:
            pass

@app.route("/<path:path>", methods=["GET"])
def static_files(path):
    if os.path.isfile(os.path.join(STATIC_DIR, path)):
        return send_from_directory(STATIC_DIR, path)
    if os.path.isfile(os.path.join(STATIC_DIR, path + ".html")):
        return send_from_directory(STATIC_DIR, path + ".html")
    return send_from_directory(STATIC_DIR, path)

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5001"))
    app.run(host="0.0.0.0", port=port, debug=True)
