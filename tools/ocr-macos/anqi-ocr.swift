import Foundation
import Vision
import PDFKit
import CoreGraphics

func fail(_ message: String) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: ["ok": false, "error": message])
    print(String(data: data, encoding: .utf8)!)
    exit(1)
}

func recognize(_ image: CGImage) -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: image)
    do { try handler.perform([request]) }
    catch { return "" }
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

let args = CommandLine.arguments
if args.count != 2 { fail("usage: anqi-ocr <file>") }
let url = URL(fileURLWithPath: args[1])
if let pdf = PDFDocument(url: url) {
    var pages: [(number: Int, text: String)] = []
    var engines = Set<String>()
    let count = min(pdf.pageCount, 5)
    for index in 0..<count {
        guard let page = pdf.page(at: index) else { continue }
        if let text = page.string, text.trimmingCharacters(in: .whitespacesAndNewlines).count >= 30 {
            pages.append((number: index + 1, text: text))
            engines.insert("pdfkit-text")
        } else if let image = page.thumbnail(of: CGSize(width: 1700, height: 2400), for: .mediaBox)
            .cgImage(forProposedRect: nil, context: nil, hints: nil) {
            pages.append((number: index + 1, text: recognize(image)))
            engines.insert("vision")
        }
    }
    let text = pages.map { "--- 第 \($0.number) 页 ---\n\($0.text)" }.joined(separator: "\n")
    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { fail("PDF 无法识别") }
    let engine = engines.contains("pdfkit-text") && engines.contains("vision") ? "pdfkit-text+vision" : (engines.first ?? "vision")
    let out: [String: Any] = ["ok": true, "text": text, "pages": count, "engine": engine]
    print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
    exit(0)
}

guard let imageSource = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(imageSource, 0, nil) else { fail("无法读取图片") }
let text = recognize(image)
if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { fail("图片无可识别文字") }
let out: [String: Any] = ["ok": true, "text": text, "pages": 1, "engine": "vision"]
print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
