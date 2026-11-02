window.report = (key, value) => window.parent.postMessage({ key, value }, "*"); report("report.js", "ran");
