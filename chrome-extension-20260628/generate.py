import os
import urllib.request
import zipfile

folder_name = "Ebook-to-PDF-Extension"
os.makedirs(folder_name, exist_ok=True)

# 1. Extension Code Files
files = {
    "manifest.json": """{
  "manifest_version": 3,
  "name": "Ebook to PDF Capturer",
  "version": "1.0",
  "description": "Automates page turning and captures eBook pages into a PDF.",
  "permissions": ["activeTab", "scripting"],
  "action": {
    "default_popup": "popup.html"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "all_frames": true,
      "js": ["jspdf.umd.min.js", "html2canvas.min.js", "content.js"]
    }
  ]
}""",
    "popup.html": """<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; width: 250px; padding: 10px; text-align: center; }
    button { background-color: #4CAF50; color: white; border: none; padding: 10px 15px; cursor: pointer; border-radius: 5px; width: 100%; margin-bottom: 10px;}
    button:hover { background-color: #45a049; }
    input { width: 90%; padding: 5px; margin-bottom: 10px; }
  </style>
</head>
<body>
  <h3>PDF Capturer</h3>
  <label>Number of pages to capture:</label>
  <input type="number" id="pageCount" value="10" min="1">
  <button id="startBtn">Start Capturing</button>
  <p id="status" style="font-size: 12px; color: gray;"></p>
  <script src="popup.js"></script>
</body>
</html>""",
    "popup.js": """document.getElementById('startBtn').addEventListener('click', async () => {
  const pageCount = parseInt(document.getElementById('pageCount').value);
  document.getElementById('status').innerText = "Capturing in progress... Don't close this tab.";
  
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: "startCapture", pages: pageCount });
});""",
    "content.js": """const PAGE_CONTAINER_SELECTOR = 'body'; 
const NEXT_BUTTON_SELECTOR = '.next-btn, [title="Next"]'; 
const WAIT_TIME_MS = 2500;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "startCapture") {
    startScraping(request.pages);
  }
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function startScraping(totalPages) {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF('p', 'mm', 'a4'); 
  let pdfWidth = pdf.internal.pageSize.getWidth();
  let pdfHeight = pdf.internal.pageSize.getHeight();

  for (let i = 0; i < totalPages; i++) {
    console.log(`Capturing page ${i + 1} of ${totalPages}...`);
    
    const pageElement = document.querySelector(PAGE_CONTAINER_SELECTOR);
    if (!pageElement) {
      alert("Could not find the page container. Check your CSS selectors in content.js!");
      return;
    }

    const canvas = await html2canvas(pageElement, { scale: 2 });
    const imgData = canvas.toDataURL('image/jpeg', 1.0);

    if (i > 0) pdf.addPage();
    
    let imgProps = pdf.getImageProperties(imgData);
    let ratio = Math.min(pdfWidth / imgProps.width, pdfHeight / imgProps.height);
    let newWidth = imgProps.width * ratio;
    let newHeight = imgProps.height * ratio;
    
    pdf.addImage(imgData, 'JPEG', 0, 0, newWidth, newHeight);

    const nextBtn = document.querySelector(NEXT_BUTTON_SELECTOR);
    if (nextBtn) {
      nextBtn.click();
      await sleep(WAIT_TIME_MS);
    } else {
      console.warn("Next button not found. Stopping early.");
      break;
    }
  }

  pdf.save("Textbook.pdf");
  alert("PDF Download Complete!");
}"""
}

# 2. Write files to folder
print("Writing extension files...")
for filename, content in files.items():
    with open(os.path.join(folder_name, filename), "w", encoding="utf-8") as f:
        f.write(content)

# 3. Download required external JS libraries
libraries = {
    "jspdf.umd.min.js": "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
    "html2canvas.min.js": "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"
}

for lib_name, url in libraries.items():
    print(f"Downloading {lib_name}...")
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req) as response, open(os.path.join(folder_name, lib_name), 'wb') as out_file:
        out_file.write(response.read())

# 4. Zip the entire folder
zip_filename = f"{folder_name}.zip"
print("Zipping files...")
with zipfile.ZipFile(zip_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
    for root, _, current_files in os.walk(folder_name):
        for file in current_files:
            zipf.write(os.path.join(root, file), file)

print(f"\nSuccess! ")
print(f"- The raw folder '{folder_name}/' was created (use this for Chrome's 'Load unpacked').")
print(f"- The zipped file '{zip_filename}' was created.")