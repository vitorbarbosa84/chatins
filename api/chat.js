// /api/chat.js - Updated for your existing spreadsheet structure

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

  if (!GOOGLE_SHEETS_API_KEY || !SPREADSHEET_ID) {
    console.warn('Google Sheets not configured properly');
    return res.status(500).json({ 
      success: false, 
      error: 'Google Sheets configuration missing. Please set GOOGLE_SHEETS_API_KEY and GOOGLE_SPREADSHEET_ID environment variables.' 
    });
  }

  // --- REQUEST DATA ---
  const { message, userId, threadId } = req.body;
  
  if (!message) {
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

    // 2. Add user message
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

    // 3. Function definitions - Updated for your spreadsheet structure
    const functionTools = [
      {
        type: "function",
        function: {
          name: "save_company_info",
          description: "Save basic company information",
          parameters: {
            type: "object",
            properties: {
              company_name: { type: "string" },
              industry: { type: "string" },
              employee_count: { type: "string" },
              annual_revenue: { type: "string" },
              user_id: { type: "string" }
            },
            required: ["company_name", "industry", "user_id"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "save_category_score",
          description: "Save a calculated score for a security category",
          parameters: {
            type: "object",
            properties: {
              category: { 
                type: "string",
                enum: [
                  "MFA Score", "Backup Score", "Vulnerability Score", 
                  "Incident Response Score", "Training Score", "Network Security Score",
                  "Data Protection Score", "Endpoint Protection Score", 
                  "Security Monitoring Score", "Physical Security Score",
                  "Vendor Risk Score", "Business Continuity Score", 
                  "Compliance Score", "Identity Management Score",
                  "Payment Security Score", "Healthcare Data Score", 
                  "Security Testing Score", "Insurance History Score"
                ]
              },
              score: { 
                type: "number",
                minimum: 1,
                maximum: 4,
                description: "Score from 1-4 (Poor, Fair, Good, Excellent)"
              }
            },
            required: ["category", "score"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "generate_quote",
          description: "Generate insurance quote based on all category scores",
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
          
          console.log(`Executing function: ${functionName}`, args);
          
          let result;
          try {
            if (functionName === 'save_company_info') {
              // Add the actual thread_id and user_id to the arguments
              args.thread_id = currentThreadId;
              args.user_id = userId || 'user_' + Date.now();
              result = await saveCompanyInfo(args, GOOGLE_SHEETS_API_KEY, SPREADSHEET_ID);
            } else if (functionName === 'save_category_score') {
              // Add the actual thread_id to the arguments
              args.thread_id = currentThreadId;
              result = await saveCategoryScore(args, GOOGLE_SHEETS_API_KEY, SPREADSHEET_ID);
            } else if (functionName === 'generate_quote') {
              result = await generateQuoteFromSheets(currentThreadId, GOOGLE_SHEETS_API_KEY, SPREADSHEET_ID);
            } else {
              result = { 
                status: 'error', 
                message: `Unknown function: ${functionName}` 
              };
            }
          } catch (error) {
            console.error(`Function ${functionName} error:`, error);
            result = {
              status: 'error',
              message: error.message
            };
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

// --- Helper Functions for Your Spreadsheet Structure ---

async function saveCompanyInfo(data, apiKey, spreadsheetId) {
  try {
    console.log('Saving company info:', data);
    
    // Get existing data
    const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Assessments!A:Z?key=${apiKey}`;
    const getResp = await fetch(getUrl);
    
    if (!getResp.ok) {
      throw new Error(`Failed to read Google Sheets: ${getResp.status}`);
    }
    
    const sheetData = await getResp.json();
    const headers = sheetData.values?.[0] || [];
    const rows = sheetData.values?.slice(1) || [];
    
    // Map your headers to the expected column names
    const headerMap = {
      'Timestamp': 0,
      'Company Name': 1,
      'Industry': 2,
      'Employee Count': 3,
      'Annual Revenue': 4,
      'User ID': 5,
      'Thread ID': 6
    };
    
    console.log('Sheet headers:', headers);
    console.log('Existing rows:', rows.length);
    console.log('Looking for thread:', data.thread_id);
    
    // Find existing row or create new one
    let rowIndex = rows.findIndex(row => row[6] === data.thread_id); // Thread ID column
    console.log('Found row index:', rowIndex);
    
    if (rowIndex === -1) {
      // Create new row
      const newRow = Array(headers.length).fill('');
      newRow[0] = new Date().toISOString(); // Timestamp
      newRow[1] = data.company_name;
      newRow[2] = data.industry;
      newRow[3] = data.employee_count;
      newRow[4] = data.annual_revenue;
      newRow[5] = data.user_id;
      newRow[6] = data.thread_id;
      
      console.log('Creating new row:', newRow);
      
      const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Assessments!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS&key=${apiKey}`;
      const appendResp = await fetch(appendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [newRow] })
      });
      
      if (!appendResp.ok) {
        const errorText = await appendResp.text();
        console.error('Append response error:', errorText);
        throw new Error(`Failed to append company info: ${appendResp.status} - ${errorText}`);
      }
      
      console.log('Row appended successfully');
    }
    } else {
      // Update existing row
      const updates = [
        { range: `Assessments!B${rowIndex + 2}`, values: [[data.company_name]] },
        { range: `Assessments!C${rowIndex + 2}`, values: [[data.industry]] },
        { range: `Assessments!D${rowIndex + 2}`, values: [[data.employee_count]] },
        { range: `Assessments!E${rowIndex + 2}`, values: [[data.annual_revenue]] }
      ];
      
      for (const update of updates) {
        const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${update.range}?valueInputOption=RAW&key=${apiKey}`;
        await fetch(updateUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: update.values })
        });
      }
    }

    return { 
      status: 'success', 
      message: 'Company info saved successfully'
    };
    
  } catch (error) {
    console.error('saveCompanyInfo error:', error);
    return {
      status: 'error',
      message: error.message
    };
  }
}

async function saveCategoryScore(data, apiKey, spreadsheetId) {
  try {
    console.log('Saving category score:', data);
    
    // Get existing data
    const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Assessments!A:Z?key=${apiKey}`;
    const getResp = await fetch(getUrl);
    
    if (!getResp.ok) {
      throw new Error(`Failed to read Google Sheets: ${getResp.status}`);
    }
    
    const sheetData = await getResp.json();
    const headers = sheetData.values?.[0] || [];
    const rows = sheetData.values?.slice(1) || [];
    
    // Find the column for this category
    const columnIndex = headers.indexOf(data.category);
    if (columnIndex === -1) {
      throw new Error(`Category ${data.category} not found in headers`);
    }
    
    // Find the row for this thread
    let rowIndex = rows.findIndex(row => row[6] === data.thread_id); // Thread ID column
    
    if (rowIndex === -1) {
      throw new Error('Thread not found. Save company info first.');
    }
    
    // Update the score
    const cellAddress = String.fromCharCode(65 + columnIndex) + (rowIndex + 2);
    const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Assessments!${cellAddress}?valueInputOption=RAW&key=${apiKey}`;
    
    const updateResp = await fetch(updateUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[data.score]] })
    });
    
    if (!updateResp.ok) {
      throw new Error('Failed to update category score');
    }

    return { 
      status: 'success', 
      message: `${data.category} updated to ${data.score}`,
      category: data.category,
      score: data.score
    };
    
  } catch (error) {
    console.error('saveCategoryScore error:', error);
    return {
      status: 'error',
      message: error.message
    };
  }
}

async function generateQuoteFromSheets(threadId, apiKey, spreadsheetId) {
  try {
    console.log('Generating quote for thread:', threadId);
    
    // Get assessment data from sheets
    const assessmentData = await getAssessmentData(threadId, apiKey, spreadsheetId);
    
    if (!assessmentData) {
      throw new Error('No assessment data found');
    }
    
    // Calculate overall risk score
    const overallRiskScore = calculateOverallRiskScore(assessmentData);
    
    // Generate quote
    const quote = generateQuote(assessmentData, overallRiskScore);
    
    return {
      status: 'success',
      quote: quote,
      message: 'Quote generated successfully'
    };
    
  } catch (error) {
    console.error('generateQuoteFromSheets error:', error);
    return {
      status: 'error',
      message: error.message
    };
  }
}

async function getAssessmentData(threadId, apiKey, spreadsheetId) {
  try {
    const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Assessments!A:Z?key=${apiKey}`;
    const getResp = await fetch(getUrl);
    
    if (!getResp.ok) {
      throw new Error('Failed to read Google Sheets');
    }
    
    const sheetData = await getResp.json();
    const headers = sheetData.values?.[0] || [];
    const rows = sheetData.values?.slice(1) || [];
    
    const row = rows.find(r => r[6] === threadId); // Thread ID column
    if (!row) {
      return null;
    }

    const result = {};
    headers.forEach((header, index) => {
      result[header] = row[index] || '';
    });
    
    return result;
    
  } catch (error) {
    console.error('getAssessmentData error:', error);
    throw error;
  }
}

function calculateOverallRiskScore(data) {
  // Your 18-category weighted scoring
  const categoryWeights = {
    'MFA Score': 0.15,
    'Backup Score': 0.12,
    'Vulnerability Score': 0.10,
    'Incident Response Score': 0.10,
    'Training Score': 0.08,
    'Network Security Score': 0.08,
    'Data Protection Score': 0.08,
    'Endpoint Protection Score': 0.07,
    'Security Monitoring Score': 0.06,
    'Physical Security Score': 0.04,
    'Vendor Risk Score': 0.04,
    'Business Continuity Score': 0.04,
    'Compliance Score': 0.03,
    'Identity Management Score': 0.03,
    'Payment Security Score': 0.03,
    'Healthcare Data Score': 0.03,
    'Security Testing Score': 0.02,
    'Insurance History Score': 0.02
  };
  
  let totalScore = 0;
  let totalWeight = 0;
  
  for (const [category, weight] of Object.entries(categoryWeights)) {
    const score = parseFloat(data[category]) || 0;
    if (score > 0) {
      totalScore += score * weight;
      totalWeight += weight;
    }
  }
  
  return totalWeight > 0 ? totalScore / totalWeight : 3.0;
}

function generateQuote(data, riskScore) {
  const companyName = data['Company Name'] || 'Your Company';
  const industry = data['Industry'] || 'Technology';
  const employeeCount = data['Employee Count'] || '1-50';
  
  // Calculate premium based on risk score and other factors
  let basePremium = 5000;
  
  // Industry modifiers
  const industryMultipliers = {
    'Healthcare': 1.2,
    'Financial': 1.2,
    'Government': 1.1,
    'Technology': 1.0,
    'Retail': 1.0,
    'Manufacturing': 0.95
  };
  
  basePremium *= (industryMultipliers[industry] || 1.0);
  
  // Risk score modifier
  const riskLevel = riskScore >= 3.5 ? 'Low' : riskScore >= 2.5 ? 'Medium' : 'High';
  const riskMultiplier = riskLevel === 'Low' ? 0.8 : riskLevel === 'High' ? 1.3 : 1.0;
  
  const annualPremium = Math.round(basePremium * riskMultiplier);
  const monthlyPremium = Math.round(annualPremium / 12);
  
  // Coverage recommendations
  let recommendedCoverage = 1000000;
  if (employeeCount === '1000+') recommendedCoverage = 50000000;
  else if (employeeCount === '251-1000') recommendedCoverage = 25000000;
  else if (employeeCount === '51-250') recommendedCoverage = 10000000;
  else if (employeeCount === '11-50') recommendedCoverage = 5000000;
  
  return {
    companyName,
    industry,
    employeeCount,
    riskLevel,
    riskScore: Math.round(riskScore * 10) / 10,
    recommendedCoverage,
    annualPremium,
    monthlyPremium,
    deductible: Math.min(50000, Math.max(5000, Math.round(recommendedCoverage * 0.01))),
    quoteId: 'CYB-' + Date.now(),
    timestamp: new Date().toISOString()
  };
}
