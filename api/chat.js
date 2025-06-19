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
  const ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID || 'asst_z7gDB3oQGSKyaqnSmGL82onH';

  if (!OPENAI_API_KEY) {
    return res.status(500).json({ 
      success: false, 
      error: 'OpenAI API key not configured' 
    });
  }

  // --- REQUEST DATA ---
  const { message, userId, threadId, assessmentData } = req.body;
  
  if (!message && !assessmentData?.requestQuote) {
    return res.status(400).json({ 
      success: false, 
      error: "Message is required" 
    });
  }

  let currentThreadId = threadId;

  try {
    // 1. Create thread if needed
    if (!currentThreadId) {
      console.log('Creating new thread...');
      const threadResp = await fetch('https://api.openai.com/v1/threads', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2'
        }
      });
      
      if (!threadResp.ok) {
        const errorText = await threadResp.text();
        console.error('Thread creation failed:', errorText);
        throw new Error(`Failed to create thread: ${threadResp.status}`);
      }
      
      const threadJson = await threadResp.json();
      currentThreadId = threadJson.id;
      console.log('Thread created:', currentThreadId);
    }

    // 2. Add user message if present
    if (message) {
      console.log('Adding message to thread...');
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
      
      if (!msgResp.ok) {
        const errorText = await msgResp.text();
        console.error('Message creation failed:', errorText);
        throw new Error(`Failed to add message: ${msgResp.status}`);
      }
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
          description: "Generate insurance quote based on assessment data",
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

    // 4. Start run
    console.log('Starting assistant run...');
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
    
    if (!runResp.ok) {
      const errorText = await runResp.text();
      console.error('Run creation failed:', errorText);
      throw new Error(`Failed to start run: ${runResp.status}`);
    }
    
    const runJson = await runResp.json();
    let runId = runJson.id;
    console.log('Run started:', runId);

    // 5. Wait for completion and handle function calls
    let attempts = 0;
    const maxAttempts = 30;
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const statusResp = await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/runs/${runId}`, {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2'
        }
      });
      
      if (!statusResp.ok) {
        throw new Error('Failed to check run status');
      }
      
      const runStatus = await statusResp.json();
      console.log(`Run status: ${runStatus.status}`);
      
      if (runStatus.status === 'completed') {
        // Get the latest assistant message
        const messagesResp = await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/messages`, {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'assistants=v2'
          }
        });
        
        if (!messagesResp.ok) {
          throw new Error('Failed to get messages');
        }
        
        const messagesJson = await messagesResp.json();
        const assistantMessage = messagesJson.data.find(msg => msg.role === 'assistant');
        
        if (assistantMessage && assistantMessage.content[0]?.text?.value) {
          return res.status(200).json({
            success: true,
            response: assistantMessage.content[0].text.value,
            threadId: currentThreadId
          });
        }
        
        throw new Error('No assistant response found');
      }
      
      if (runStatus.status === 'requires_action') {
        console.log('Handling function calls...');
        const toolCalls = runStatus.required_action.submit_tool_outputs.tool_calls;
        const toolOutputs = [];
        
        for (const toolCall of toolCalls) {
          const functionName = toolCall.function.name;
          const args = JSON.parse(toolCall.function.arguments);
          
          console.log(`Executing function: ${functionName}`);
          
          let result;
          if (functionName === 'save_answer') {
            result = await saveAnswerToSheet(args, GOOGLE_SHEETS_API_KEY, SPREADSHEET_ID);
          } else if (functionName === 'generate_quote') {
            result = await generateQuote(args.thread_id, GOOGLE_SHEETS_API_KEY, SPREADSHEET_ID);
          } else {
            result = { error: `Unknown function: ${functionName}` };
          }
          
          toolOutputs.push({
            tool_call_id: toolCall.id,
            output: JSON.stringify(result)
          });
        }
        
        // Submit tool outputs
        const submitResp = await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/runs/${runId}/submit_tool_outputs`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
            'OpenAI-Beta': 'assistants=v2'
          },
          body: JSON.stringify({
            tool_outputs: toolOutputs
          })
        });
        
        if (!submitResp.ok) {
          const errorText = await submitResp.text();
          console.error('Failed to submit tool outputs:', errorText);
          throw new Error('Failed to submit tool outputs');
        }
      }
      
      if (runStatus.status === 'failed' || runStatus.status === 'cancelled' || runStatus.status === 'expired') {
        throw new Error(`Run ${runStatus.status}: ${runStatus.last_error?.message || 'Unknown error'}`);
      }
      
      attempts++;
    }
    
    throw new Error('Run timeout - assistant did not respond within expected time');
    
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
}

// --- Helper Functions ---

async function saveAnswerToSheet({ field, value, user_id, thread_id }, apiKey, spreadsheetId) {
  if (!apiKey || !spreadsheetId) {
    console.log('Google Sheets not configured, saving locally');
    return { status: 'success', message: 'Data saved locally', field, value };
  }

  try {
    const getRowsUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Assessments!A:Z?key=${apiKey}`;
    const getRowsResp = await fetch(getRowsUrl);
    
    if (!getRowsResp.ok) {
      throw new Error('Failed to access Google Sheets');
    }
    
    const data = await getRowsResp.json();
    const headers = data.values?.[0] || [];
    const rows = data.values?.slice(1) || [];

    let rowIndex = rows.findIndex(row => row[0] === thread_id);
    let fieldColIndex = headers.indexOf(field);

    if (fieldColIndex === -1) {
      console.log(`Field ${field} not found in headers`);
      return { status: 'error', message: `Field ${field} not found` };
    }

    if (rowIndex === -1) {
      // Create new row
      const newRow = Array(headers.length).fill('');
      newRow[0] = thread_id;
      newRow[1] = user_id;
      newRow[fieldColIndex] = value;
      
      const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Assessments!A1:append?valueInputOption=RAW&key=${apiKey}`;
      const appendResp = await fetch(appendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [newRow] })
      });
      
      if (!appendResp.ok) {
        throw new Error('Failed to append to Google Sheets');
      }
    } else {
      // Update existing row
      const updateCell = String.fromCharCode(65 + fieldColIndex) + (rowIndex + 2);
      const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Assessments!${updateCell}?valueInputOption=RAW&key=${apiKey}`;
      const updateResp = await fetch(updateUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [[value]] })
      });
      
      if (!updateResp.ok) {
        throw new Error('Failed to update Google Sheets');
      }
    }

    return { status: 'success', message: 'Data saved to Google Sheets', field, value };
  } catch (error) {
    console.error('Google Sheets error:', error);
    return { status: 'error', message: error.message, field, value };
  }
}

async function getAssessmentRowFromSheet(threadId, apiKey, spreadsheetId) {
  if (!apiKey || !spreadsheetId) {
    return { thread_id: threadId };
  }

  try {
    const getRowsUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Assessments!A:Z?key=${apiKey}`;
    const getRowsResp = await fetch(getRowsUrl);
    
    if (!getRowsResp.ok) {
      throw new Error('Failed to access Google Sheets');
    }
    
    const data = await getRowsResp.json();
    const headers = data.values?.[0] || [];
    const rows = data.values?.slice(1) || [];

    const row = rows.find(r => r[0] === threadId);
    if (!row) {
      return { thread_id: threadId };
    }

    const result = {};
    headers.forEach((header, index) => {
      result[header] = row[index] || '';
    });
    
    return result;
  } catch (error) {
    console.error('Error getting assessment data:', error);
    return { thread_id: threadId };
  }
}

async function generateQuote(threadId, apiKey, spreadsheetId) {
  try {
    const rowData = await getAssessmentRowFromSheet(threadId, apiKey, spreadsheetId);
    
    // Calculate quote based on assessment data
    const quote = calculateQuoteLocally(rowData);
    
    return {
      status: 'success',
      quote: quote,
      formatted: formatQuoteResponse(quote)
    };
  } catch (error) {
    console.error('Quote generation error:', error);
    return {
      status: 'error',
      message: error.message,
      quote: calculateQuoteLocally({ thread_id: threadId })
    };
  }
}

function calculateQuoteLocally(rowData) {
  // Basic quote calculation - you can enhance this with your actual logic
  const companyName = rowData.companyName || rowData.company_name || "Your Company";
  const industry = rowData.industry || "Technology";
  const employeeCount = rowData.employeeCount || rowData.employee_count || "1-50";
  
  // Simple risk scoring based on available data
  let riskScore = 3.0; // Default medium risk
  let riskLevel = "Medium";
  
  // Adjust based on some basic factors
  if (rowData.mfa_implemented === "Yes") riskScore += 0.3;
  if (rowData.backup_tested === "Yes") riskScore += 0.2;
  if (rowData.security_training === "Yes") riskScore += 0.2;
  
  if (riskScore >= 3.5) riskLevel = "Low";
  else if (riskScore < 2.5) riskLevel = "High";
  
  // Basic premium calculation
  let basePremium = 5000;
  if (industry === "Healthcare") basePremium *= 1.3;
  if (industry === "Financial") basePremium *= 1.2;
  
  const riskMultiplier = riskLevel === "Low" ? 0.8 : riskLevel === "High" ? 1.3 : 1.0;
  const annualPremium = Math.round(basePremium * riskMultiplier);
  
  return {
    companyName,
    industry,
    employeeCount,
    riskLevel,
    riskScore: Math.min(4.0, riskScore),
    recommendedCoverage: 1000000,
    annualPremium,
    monthlyPremium: Math.round(annualPremium / 12),
    deductible: 10000,
    quoteId: "CYB-" + Date.now(),
    timestamp: new Date().toISOString()
  };
}

function formatQuoteResponse(quote) {
  return `
🔒 **CYBERSECURITY INSURANCE QUOTE**

**Company**: ${quote.companyName}
**Industry**: ${quote.industry} | **Employees**: ${quote.employeeCount}
**Risk Assessment**: ${quote.riskLevel} Risk (Score: ${quote.riskScore.toFixed(1)}/4.0)

💰 **RECOMMENDED COVERAGE**
• **Coverage Limit**: $${quote.recommendedCoverage?.toLocaleString()}
• **Annual Premium**: $${quote.annualPremium?.toLocaleString()}
• **Monthly Premium**: $${quote.monthlyPremium?.toLocaleString()}
• **Deductible**: $${quote.deductible?.toLocaleString()}

⏰ **Quote Details**
• Quote ID: ${quote.quoteId}
• Valid until: ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString()}
• Generated: ${new Date(quote.timestamp).toLocaleDateString()}

This quote is based on your current cybersecurity assessment. Improving your security controls could reduce your premium by up to 25%.
`;
}
