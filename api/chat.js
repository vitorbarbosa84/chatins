// /api/chat.js

export default async function handler(req, res) {
  // --- CORS ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed. Please use POST.' });
  }

  // --- ENV ---
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const GOOGLE_SHEETS_API_KEY = process.env.GOOGLE_SHEETS_API_KEY;
  const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
  const ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID;

  // --- REQUEST DATA ---
  const { message, userId, threadId, assessmentData } = req.body;
  if (!message && !assessmentData?.requestQuote) {
    return res.status(400).json({ success: false, error: "Message is required" });
  }
  let currentThreadId = threadId;

  try {
    // 1. Create thread if needed
    if (!currentThreadId) {
      const threadResp = await fetch('https://api.openai.com/v1/threads', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2'
        }
      });
      if (!threadResp.ok) throw new Error('Failed to create thread');
      const threadJson = await threadResp.json();
      currentThreadId = threadJson.id;
    }

    // 2. Add user message if present
    if (message) {
      const msgResp = await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2'
        },
        body: JSON.stringify({
          role: 'user',
          content: message
        })
      });
      if (!msgResp.ok) throw new Error('Failed to add message to thread');
    }

    // 3. Function definitions
    const functionTools = [
      {
        type: "function",
        function: {
          name: "save_answer",
          description: "Save a user's answer to a specific assessment field",
          parameters: {
            type: "object",
            properties: {
              field: { type: "string" },
              value: { type: "string" },
              user_id: { type: "string" },
              thread_id: { type: "string" }
            },
            required: ["field", "value", "user_id", "thread_id"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "generate_quote",
          description: "Generate insurance quote",
          parameters: {
            type: "object",
            properties: {
              thread_id: { type: "string" }
            },
            required: ["thread_id"]
          }
        }
      }
    ];

    // 4. Start initial run
    const runResp = await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/runs`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      body: JSON.stringify({
        assistant_id: ASSISTANT_ID,
        tools: functionTools
      })
    });
    if (!runResp.ok) throw new Error('Failed to start run');
    const runJson = await runResp.json();
    let runId = runJson.id;

    // 5. Run loop: handle function calls until we get a natural reply
    let reply = "";
    let loopSafety = 0;
    while (loopSafety < 5) {
      // Poll for run status
      let runStatus = "in_progress", attempts = 0, maxAttempts = 30;
      while (attempts < maxAttempts && runStatus !== "completed" && runStatus !== "requires_action") {
        await new Promise(r => setTimeout(r, 1000));
        const statusResp = await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/runs/${runId}`, {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'assistants=v2'
          }
        });
        if (!statusResp.ok) throw new Error('Failed to check run status');
        const statusJson = await statusResp.json();
        runStatus = statusJson.status;
        attempts++;
      }

      // Get latest message
      const messagesResp = await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/messages`, {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2'
        }
      });
      if (!messagesResp.ok) throw new Error('Failed to get messages');
      const messagesJson = await messagesResp.json();
      const latest = messagesJson.data[0];

      // If assistant replied in text, return it
      if (latest.role === "assistant" && latest.content[0]?.text?.value) {
        reply = latest.content[0].text.value;
        break;
      }

      // If function call, handle it
      if (latest.role === "assistant" && latest.content[0]?.type === "function_call") {
        const funcCall = latest.content[0].function_call;
        const functionName = funcCall.name;
        const args = JSON.parse(funcCall.arguments);

        if (functionName === "save_answer") {
          await saveAnswerToSheet(args, GOOGLE_SHEETS_API_KEY, SPREADSHEET_ID);
          // Post function result message
          await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/messages`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${OPENAI_API_KEY}`,
              'Content-Type': 'application/json',
              'OpenAI-Beta': 'assistants=v2'
            },
            body: JSON.stringify({
              role: "function",
              name: "save_answer",
              content: JSON.stringify({ status: "success", field: args.field, value: args.value })
            })
          });
        }

        if (functionName === "generate_quote") {
          const sheetRow = await getAssessmentRowFromSheet(currentThreadId, GOOGLE_SHEETS_API_KEY, SPREADSHEET_ID);
          let quote;
          if (GOOGLE_SHEETS_API_KEY && SPREADSHEET_ID) {
            quote = await processInsuranceQuoteWithSheets(sheetRow, GOOGLE_SHEETS_API_KEY, SPREADSHEET_ID);
          } else {
            quote = calculateQuoteLocally(sheetRow);
          }
          // Post function result message
          await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/messages`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${OPENAI_API_KEY}`,
              'Content-Type': 'application/json',
              'OpenAI-Beta': 'assistants=v2'
            },
            body: JSON.stringify({
              role: "function",
              name: "generate_quote",
              content: JSON.stringify(quote)
            })
          });
        }

        // Start a new run after function result
        const continueRunResp = await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/runs`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
            'OpenAI-Beta': 'assistants=v2'
          },
          body: JSON.stringify({ assistant_id: ASSISTANT_ID })
        });
        if (!continueRunResp.ok) throw new Error('Failed to continue run after function call');
        const continueRunJson = await continueRunResp.json();
        runId = continueRunJson.id;
      }

      loopSafety++;
    } // end loop

    return res.status(200).json({ success: true, response: reply, threadId: currentThreadId });
  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Internal error' });
  }
}

// --- Helper: Save Answer to Sheet ---
async function saveAnswerToSheet({ field, value, user_id, thread_id }, apiKey, spreadsheetId) {
  const getRowsUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Assessments!A:Z?key=${apiKey}`;
  const getRowsResp = await fetch(getRowsUrl);
  const data = await getRowsResp.json();
  const headers = data.values[0];
  const rows = data.values.slice(1);

  let rowIndex = rows.findIndex(row => row[0] === thread_id);
  let fieldColIndex = headers.indexOf(field);

  if (rowIndex === -1) {
    const newRow = Array(headers.length).fill('');
    newRow[0] = thread_id;
    newRow[1] = user_id;
    newRow[fieldColIndex] = value;
    const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Assessments!A1:append?valueInputOption=RAW&key=${apiKey}`;
    await fetch(appendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [newRow] })
    });
  } else {
    const updateCell = String.fromCharCode(65 + fieldColIndex) + (rowIndex + 2); // e.g., 'C5'
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Assessments!${updateCell}?valueInputOption=RAW&key=${apiKey}`;
    await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[value]] })
    });
  }
}

// --- Helper: Get Row Data for a Thread ---
async function getAssessmentRowFromSheet(threadId, apiKey, spreadsheetId) {
  const getRowsUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Assessments!A:Z?key=${apiKey}`;
  const getRowsResp = await fetch(getRowsUrl);
  const data = await getRowsResp.json();
  const headers = data.values[0];
  const rows = data.values.slice(1);

  const row = rows.find(r => r[0] === threadId);
  if (!row) throw new Error('No data found for this thread');
  const result = {};
  headers.forEach((h, i) => {
    result[h] = row[i];
  });
  return result;
}

// --- QUOTE GENERATION PLACEHOLDER ---
// Paste your processInsuranceQuoteWithSheets, calculateQuoteLocally, formatQuoteResponse, etc. here.
function formatQuoteResponse(quote) {
  return `
🔒 **CYBERSECURITY INSURANCE QUOTE**

**Company**: ${quote.companyName}
**Industry**: ${quote.industry} | **Employees**: ${quote.employeeCount}
**Risk Assessment**: ${quote.riskLevel} Risk (Score: ${quote.riskScore}/4.0)

💰 **RECOMMENDED COVERAGE**
• **Coverage Limit**: $${quote.recommendedCoverage?.toLocaleString()}
• **Annual Premium**: $${quote.annualPremium?.toLocaleString()}
• **Monthly Premium**: $${quote.monthlyPremium?.toLocaleString()}
• **Deductible**: $${quote.deductible?.toLocaleString()}

⏰ **Quote Details**
• Quote ID: ${quote.quoteId}
• Valid until: ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString()}
• Generated: ${new Date(quote.timestamp).toLocaleDateString()}
`;
}

// Use your real quote logic here
function calculateQuoteLocally(rowObj) {
  return {
    companyName: rowObj.companyName || "Unknown",
    industry: rowObj.industry || "Unknown",
    employeeCount: rowObj.employeeCount || "Unknown",
    riskLevel: "Medium",
    riskScore: 3,
    recommendedCoverage: 1000000,
    annualPremium: 5000,
    monthlyPremium: 416,
    deductible: 10000,
    quoteId: "CYB-" + Date.now(),
    timestamp: new Date().toISOString()
  };
}
async function processInsuranceQuoteWithSheets(rowObj, apiKey, spreadsheetId) {
  return calculateQuoteLocally(rowObj); // For now, just use local version
}
