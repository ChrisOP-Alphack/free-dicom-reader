import DicomViewer from "@/components/DicomViewer";

export default function Home() {
  return (
    <main style={{ minHeight: "100vh", background: "#000", color: "#fff" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
        <header style={{ marginBottom: 16 }}>
          <h1 style={{ margin: 0, fontSize: 32, fontWeight: 900 }}>
            Free Dicom Reader
          </h1>
          <p style={{ marginTop: 8, opacity: 0.8 }}>
            Upload a DICOM file (.dcm) to view it. Rendering happens locally in your browser.
          </p>
        </header>

        <DicomViewer />
      </div>
    </main>
  );
}
