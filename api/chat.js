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
    // --- 1. CREATE THREAD IF NEEDED ---
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

    // --- 2. ADD USER MESSAGE IF PRESENT ---
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

    // --- 3. FUNCTION DEFINITIONS ---
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

    // --- 4. LEGACY DIRECT QUOTE REQUEST (optional) ---
    if (assessmentData && assessmentData.requestQuote) {
      const sheetRow = await getAssessmentRowFromSheet(currentThreadId, GOOGLE_SHEETS_API_KEY, SPREADSHEET_ID);
      let quote;
      if (GOOGLE_SHEETS_API_KEY && SPREADSHEET_ID) {
        quote = await processInsuranceQuoteWithSheets(sheetRow, GOOGLE_SHEETS_API_KEY, SPREADSHEET_ID);
      } else {
        quote = calculateQuoteLocally(sheetRow);
      }
      return res.status(200).json({
        success: true,
        response: formatQuoteResponse(quote),
        threadId: currentThreadId,
        quote: quote,
        type: 'quote'
      });
    }

    // --- 5. START RUN WITH FUNCTION CALLING ---
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
    const runId = runJson.id;

    // --- 6. WAIT FOR RUN TO REACH 'requires_action' OR 'completed' ---
    let runStatus = "in_progress";
    let attempts = 0, maxAttempts = 30;
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

    // --- 7. GET MESSAGES ---
    const messagesResp = await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/messages`, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'assistants=v2'
      }
    });
    if (!messagesResp.ok) throw new Error('Failed to get messages');
    const messagesJson = await messagesResp.json();
    const latest = messagesJson.data[0];

    // --- 8. FUNCTION CALL HANDLING ---
    if (latest.role === "assistant" && latest.content[0]?.type === "function_call") {
      const funcCall = latest.content[0].function_call;
      const functionName = funcCall.name;
      const args = JSON.parse(funcCall.arguments);

      if (functionName === "save_answer") {
        await saveAnswerToSheet(args, GOOGLE_SHEETS_API_KEY, SPREADSHEET_ID);
        // Post function result
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
        // Continue the run so assistant can go on
        await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/runs`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
            'OpenAI-Beta': 'assistants=v2'
          },
          body: JSON.stringify({ assistant_id: ASSISTANT_ID })
        });
        return res.status(200).json({ success: true, type: 'function_call', message: "Answer saved.", threadId: currentThreadId });
      }

      if (functionName === "generate_quote") {
        const sheetRow = await getAssessmentRowFromSheet(currentThreadId, GOOGLE_SHEETS_API_KEY, SPREADSHEET_ID);
        let quote;
        if (GOOGLE_SHEETS_API_KEY && SPREADSHEET_ID) {
          quote = await processInsuranceQuoteWithSheets(sheetRow, GOOGLE_SHEETS_API_KEY, SPREADSHEET_ID);
        } else {
          quote = calculateQuoteLocally(sheetRow);
        }
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
        await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/runs`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
            'OpenAI-Beta': 'assistants=v2'
          },
          body: JSON.stringify({ assistant_id: ASSISTANT_ID })
        });
        return res.status(200).json({ success: true, type: 'function_call', message: "Quote generated.", threadId: currentThreadId });
      }
    }

    // --- 9. REGULAR ASSISTANT REPLY ---
    let reply = "";
    if (latest.role === "assistant" && latest.content[0]?.text?.value) {
      reply = latest.content[0].text.value;
    }
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

// Dummy fallback for local quote calculation (you can paste your real logic)
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

// Dummy placeholder for Google Sheets logic (replace with your real formula logic)
async function processInsuranceQuoteWithSheets(rowObj, apiKey, spreadsheetId) {
  return calculateQuoteLocally(rowObj); // For now, just use local version
}


// Function to process insurance quote using Google Sheets
async function processInsuranceQuoteWithSheets(assessmentData, apiKey, spreadsheetId) {
  console.log('Processing quote with Google Sheets...');
  
  try {
    // Prepare data for Google Sheets
    const timestamp = new Date().toISOString();
    const sheetData = [
      ['Timestamp', timestamp],
      ['Company Name', assessmentData.companyName || ''],
      ['Industry', assessmentData.industry || ''],
      ['Employee Count', assessmentData.employeeCount || ''],
      ['Annual Revenue', assessmentData.annualRevenue || ''],
      ['User ID', assessmentData.userId || ''],
      ['Thread ID', assessmentData.threadId || ''],
      
      // Category scores with defaults
      ['MFA Score', assessmentData.scores?.mfa || 1],
      ['Backup Score', assessmentData.scores?.backup || 1],
      ['Vulnerability Mgmt Score', assessmentData.scores?.vulnerability || 1],
      ['Incident Response Score', assessmentData.scores?.incident || 1],
      ['Employee Training Score', assessmentData.scores?.training || 1],
      ['Network Security Score', assessmentData.scores?.network || 1],
      ['Data Protection Score', assessmentData.scores?.dataProtection || 1],
      ['Endpoint Protection Score', assessmentData.scores?.endpoint || 1],
      ['Security Monitoring Score', assessmentData.scores?.monitoring || 1],
      ['Physical Security Score', assessmentData.scores?.physical || 1],
      ['Vendor Risk Score', assessmentData.scores?.vendor || 1],
      ['Business Continuity Score', assessmentData.scores?.continuity || 1],
      ['Compliance Score', assessmentData.scores?.compliance || 1],
      ['Identity Mgmt Score', assessmentData.scores?.identity || 1],
      ['Payment Security Score', assessmentData.scores?.payment || 1],
      ['Healthcare Data Score', assessmentData.scores?.healthcare || 1],
      ['Security Testing Score', assessmentData.scores?.testing || 1],
      ['Insurance History Score', assessmentData.scores?.history || 1]
    ];

    // Write to Google Sheets (append to Assessments sheet)
    const writeUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Assessments!A:B:append?valueInputOption=RAW&key=${apiKey}`;
    
    const writeResponse = await fetch(writeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        values: sheetData
      })
    });

    if (!writeResponse.ok) {
      const errorText = await writeResponse.text();
      console.error('Google Sheets write failed:', errorText);
      throw new Error('Failed to write assessment data to Google Sheets');
    }

    console.log('Data written to Google Sheets successfully');

    // Small delay to allow Google Sheets to calculate
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Read calculated results from Google Sheets
    const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Calculations!A35:B60?key=${apiKey}`;
    
    const readResponse = await fetch(readUrl);
    if (!readResponse.ok) {
      const errorText = await readResponse.text();
      console.error('Google Sheets read failed:', errorText);
      throw new Error('Failed to read calculations from Google Sheets');
    }

    const sheetResults = await readResponse.json();
    const values = sheetResults.values || [];
    
    console.log('Retrieved calculation results from Google Sheets');
    
    // Parse the calculated quote from the sheets
    const quote = parseQuoteFromSheets(values, assessmentData);
    
    return quote;

  } catch (error) {
    console.error('Google Sheets processing error:', error);
    throw error;
  }
}

// Function to parse quote results from Google Sheets
function parseQuoteFromSheets(sheetValues, assessmentData) {
  try {
    // Create a lookup object from the sheet values
    const dataLookup = {};
    sheetValues.forEach(row => {
      if (row.length >= 2) {
        dataLookup[row[0]] = row[1];
      }
    });

    // Extract calculated values (adjust based on your sheet structure)
    const riskScore = parseFloat(dataLookup['Final Risk Score']) || 2.5;
    const riskLevel = dataLookup['Risk Level'] || 'Medium';
    const recommendedCoverage = parseFloat(dataLookup['Recommended Coverage']) || 1000000;
    const finalPremium = parseFloat(dataLookup['Final Premium']) || 5000;
    const deductible = parseFloat(dataLookup['Recommended Deductible']) || 10000;
    const basePremium = parseFloat(dataLookup['Base Premium']) || 4000;
    
    return {
      riskScore: riskScore,
      riskLevel: riskLevel,
      recommendedCoverage: recommendedCoverage,
      annualPremium: Math.round(finalPremium),
      monthlyPremium: Math.round(finalPremium / 12),
      deductible: deductible,
      basePremium: Math.round(basePremium),
      companyName: assessmentData.companyName,
      industry: assessmentData.industry,
      employeeCount: assessmentData.employeeCount,
      quoteValid: 30, // days
      timestamp: new Date().toISOString(),
      quoteId: `CYB-${Date.now()}`
    };
  } catch (error) {
    console.error('Error parsing quote from sheets:', error);
    throw new Error('Failed to parse calculation results from Google Sheets');
  }
}

// Fallback function for local quote calculation
function calculateQuoteLocally(assessmentData) {
  console.log('Using local quote calculation fallback...');
  
  // Industry base rates (per $1M coverage)
  const industryRates = {
    'Healthcare': 1200,
    'Financial Services': 1100,
    'Technology': 800,
    'Education': 900,
    'Manufacturing': 700,
    'Retail': 750,
    'Professional Services': 650,
    'Government': 1000,
    'Other': 750
  };

  // Size modifiers
  const sizeModifiers = {
    '1-10': 0.9,
    '11-50': 0.95,
    '51-250': 1.0,
    '251-1000': 1.05,
    '1000+': 1.1
  };

  // Calculate weighted risk score
  const scores = assessmentData.scores || {};
  const weights = {
    mfa: 0.15, backup: 0.12, vulnerability: 0.10, incident: 0.10, training: 0.08
  };
  
  let riskScore = 0;
  Object.keys(weights).forEach(category => {
    riskScore += (scores[category] || 1) * weights[category];
  });
  
  // Add remaining categories with equal weight
  const remainingWeight = 1 - Object.values(weights).reduce((a, b) => a + b, 0);
  const remainingCategories = 13; // Total 18 - 5 major categories
  const categoryWeight = remainingWeight / remainingCategories;
  
  riskScore += categoryWeight * remainingCategories * 2; // Assume average score of 2
  
  // Apply modifiers
  const baseRate = industryRates[assessmentData.industry] || industryRates['Other'];
  const sizeModifier = sizeModifiers[assessmentData.employeeCount] || 1.0;
  
  // Determine coverage and premium
  const recommendedCoverage = getRecommendedCoverage(assessmentData.annualRevenue);
  const basePremium = (recommendedCoverage / 1000000) * baseRate;
  
  // Risk multiplier
  let riskMultiplier = 1.0;
  if (riskScore >= 3.5) riskMultiplier = 0.85; // Low risk discount
  else if (riskScore < 2.5) riskMultiplier = 1.25; // High risk penalty
  
  const finalPremium = Math.round(basePremium * riskMultiplier * sizeModifier);
  
  return {
    riskScore: Math.round(riskScore * 100) / 100,
    riskLevel: riskScore >= 3.5 ? 'Low' : riskScore >= 2.5 ? 'Medium' : 'High',
    recommendedCoverage: recommendedCoverage,
    annualPremium: finalPremium,
    monthlyPremium: Math.round(finalPremium / 12),
    deductible: getRecommendedDeductible(recommendedCoverage),
    basePremium: Math.round(basePremium),
    companyName: assessmentData.companyName,
    industry: assessmentData.industry,
    employeeCount: assessmentData.employeeCount,
    quoteValid: 30,
    timestamp: new Date().toISOString(),
    quoteId: `CYB-${Date.now()}`
  };
}

// Helper function to get recommended coverage
function getRecommendedCoverage(revenueRange) {
  const coverageMap = {
    '<$1M': 1000000,
    '$1M-$10M': 5000000,
    '$10M-$100M': 25000000,
    '$100M+': 50000000
  };
  return coverageMap[revenueRange] || 1000000;
}

// Helper function to get recommended deductible
function getRecommendedDeductible(coverage) {
  if (coverage <= 5000000) return 10000;
  if (coverage <= 15000000) return 25000;
  return 50000;
}

// Function to format the quote response for the user
function formatQuoteResponse(quote) {
  return `🔒 **CYBERSECURITY INSURANCE QUOTE**

**Company**: ${quote.companyName}
**Industry**: ${quote.industry} | **Employees**: ${quote.employeeCount}
**Risk Assessment**: ${quote.riskLevel} Risk (Score: ${quote.riskScore}/4.0)

💰 **RECOMMENDED COVERAGE**
• **Coverage Limit**: $${quote.recommendedCoverage.toLocaleString()}
• **Annual Premium**: $${quote.annualPremium.toLocaleString()}
• **Monthly Premium**: $${quote.monthlyPremium.toLocaleString()}
• **Deductible**: $${quote.deductible.toLocaleString()}

📋 **COVERAGE INCLUDES**
✅ Data breach response & notification costs
✅ Cyber extortion & ransomware coverage
✅ Business interruption from cyber events
✅ Network security & privacy liability
✅ Regulatory fines & penalties
✅ Crisis management & PR services
✅ Forensic investigation costs
✅ Legal defense & settlements

💡 **YOUR RISK PROFILE**
${quote.riskLevel === 'Low' ? '🟢 **Excellent Security** - Your strong cybersecurity controls qualify you for preferred pricing!' :
  quote.riskLevel === 'Medium' ? '🟡 **Good Foundation** - Solid security with room for improvement to reduce premiums.' :
  '🔴 **Needs Attention** - Significant security gaps identified. Improvements could reduce your premium significantly.'}

⏰ **Quote Details**
• Quote ID: ${quote.quoteId}
• Valid until: ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString()}
• Generated: ${new Date(quote.timestamp).toLocaleDateString()}

**Next Steps**: Contact us to finalize your policy or ask about ways to improve your security posture for better rates!`;
}
