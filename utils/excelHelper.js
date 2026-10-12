const ExcelJS = require('exceljs');

class ExcelHelper {

  static async readExcelData(filePath, sheetName) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.getWorksheet(sheetName);

    if (!sheet) throw new Error(`Sheet "${sheetName}" not found in ${filePath}`);

    // Read header row
    const headerRow = sheet.getRow(1);
    const headers = [];
    headerRow.eachCell((cell) => headers.push(String(cell.value).trim()));

    // Read ALL data rows
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const rowData = {};
      headers.forEach((header, i) => {
        const cell = row.getCell(i + 1);
        rowData[header] = String(cell.text ?? cell.value ?? '').trim();
      });
      rows.push(rowData);
    });

    // ---- PROXY to support column access (Header first, index next) ----
    return new Proxy(rows, {
      get(target, prop) {
        // Array behaviour: iteration, length, map/filter, numeric index (policyLines[0])
        if (typeof prop === 'symbol' || prop in target) {
          const value = target[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        }

        // Column access: policyLines["RT"]
        if (target.length > 0 && prop in target[0]) {
          const colValues = target.map(row => row[prop]);
          return new Proxy(colValues, {
            get(colTarget, colIndex) {
              if (!isNaN(colIndex)) return colTarget[colIndex]; // policyLines["RT"][1]
              return undefined;
            }
          });
        }

        return undefined;
      }
    });
  }

  // List sheet names
  static async getWorksheetNames(filePath) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    return workbook.worksheets.map(sheet => sheet.name);
  }

  /**
   * Picks data rows by their Excel row number, as shown in Excel (row 1 is the
   * header, so 2 = first data row). Accepts a single number, a comma list,
   * ranges, or a mix:
   *   2          -> row 2
   *   '2,3,4'    -> rows 2, 3, 4
   *   '5-9'      -> rows 5, 6, 7, 8, 9
   *   '2,4,6-8'  -> rows 2, 4, 6, 7, 8
   * Rows are returned in the order given; duplicates are ignored.
   */
  static selectRows(rows, selection) {
    const firstDataRow = 2;
    const lastDataRow = rows.length + 1;
    const rowNumbers = [];
    for (const part of String(selection).split(',').map(p => p.trim()).filter(Boolean)) {
      const match = part.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
      if (!match) throw new Error(`Invalid row selection "${part}" — use e.g. 2, 2,3,4 or 5-9`);

      const start = Number(match[1]);
      const end = Number(match[2] ?? match[1]);
      if (start < firstDataRow) throw new Error(`Invalid row "${part}" — row 1 is the header, data starts at row 2`);
      if (end < start) throw new Error(`Invalid row range "${part}"`);

      for (let n = start; n <= end; n++) {
        if (n > lastDataRow) throw new Error(`Row ${n} does not exist — data is in rows 2-${lastDataRow}`);
        if (!rowNumbers.includes(n)) rowNumbers.push(n);
      }
    }
    return rowNumbers.map(n => rows[n - firstDataRow]);
  }
}

module.exports = ExcelHelper;











































// const ExcelJS = require('exceljs');

// class ExcelHelper {

//   static async readExcelData(filePath, sheetName) {
//     const workbook = new ExcelJS.Workbook();
//     await workbook.xlsx.readFile(filePath);
//     const sheet = workbook.getWorksheet(sheetName);

//     if (!sheet) throw new Error(`Sheet "${sheetName}" not found in ${filePath}`);

//     // Read header row
//     const headerRow = sheet.getRow(1);
//     const headers = [];
//     headerRow.eachCell((cell) => headers.push(String(cell.value).trim()));

//     // Read ALL data rows
//     const rows = [];
//     sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
//       if (rowNumber === 1) return;
//       const rowData = {};
//       headers.forEach((header, i) => {
//         rowData[header] = String(row.getCell(i + 1).value ?? '').trim();
//       });
//       rows.push(rowData);
//     });

//     // ---- PROXY to support column access (Header first, index next) ----
//     return new Proxy(rows, {
//       get(target, prop) {
//         // Numeric index access: policyLines[0]
//         if (!isNaN(prop)) return target[prop];

//         // Column access: policyLines["RT"]
//         if (target.length > 0 && prop in target[0]) {
//           const colValues = target.map(row => row[prop]);
//           return new Proxy(colValues, {
//             get(colTarget, colIndex) {
//               if (!isNaN(colIndex)) return colTarget[colIndex]; // policyLines["RT"][1]
//               return undefined;
//             }
//           });
//         }

//         return undefined;
//       }
//     });
//   }

//   // List sheet names
//   static async getWorksheetNames(filePath) {
//     const workbook = new ExcelJS.Workbook();
//     await workbook.xlsx.readFile(filePath);
//     return workbook.worksheets.map(sheet => sheet.name);
//   }
// }

// module.exports = ExcelHelper;



























//  const ExcelJS = require('exceljs');
 


 

// /**
//  * ExcelHelper class provides utility functions for reading Excel (.xlsx) files.
//  */
// class ExcelHelper {
// 	/**
// 	 * Reads data from an Excel sheet.
// 	 *
// 	 * - If `rowIndex` is provided, returns a single row object (excluding the header).
// 	 * - If `rowIndex` is omitted, returns an array of all row objects below the header.
// 	 *
// 	 * @param {string} filePath - The full path to the Excel (.xlsx) file.
// 	 * @param {string} sheetName - The name of the sheet to read data from.
// 	 * @param {number} [rowIndex] - (Optional) 1-based index of the row to read (must be > 1).
// 	 * @returns {Promise<Object|Object[]>}
// 	 * @throws {Error} If the sheet or specified row is missing or invalid.
// 	 *
// 	 * @example
// 	 * const settings = await ExcelHelper.readExcelData('data.xlsx', 'Settings', 2);
// 	 * console.log(settings["API Key"]);
// 	 *
// 	 * @example
// 	 * const users = await ExcelHelper.readExcelData('data.xlsx', 'Users');
// 	 * console.log(users[0].Name);
// 	 */
// 	static async readExcelData(filePath, sheetName, rowIndex) {
// 		const workbook = new ExcelJS.Workbook();
// 		await workbook.xlsx.readFile(filePath);
// 		const sheet = workbook.getWorksheet(sheetName);

// 		if (!sheet) {
// 			throw new Error(`Sheet "${sheetName}" not found in ${filePath}`);
// 		}

// 		const headerRow = sheet.getRow(1);
// 		const headers = [];
// 		headerRow.eachCell((cell) => {
// 			headers.push(cell.value);
// 		});

// 		if (rowIndex !== undefined) {
// 			if (rowIndex <= 1) throw new Error('Row index must be greater than 1 to skip header');
// 			const row = sheet.getRow(rowIndex);
// 			if (!row || row.cellCount === 0) throw new Error(`Row ${rowIndex} is empty or does not exist`);

// 			const rowData = {};
// 			headers.forEach((header, i) => {
// 				//rowData[header] = row.getCell(i + 1).value;
// 				rowData[header] = String(row.getCell(i + 1).value ?? '');

// 			});
// 			return rowData;
// 		} else {
// 			const data = [];
// 			sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
// 				if (rowNumber === 1) return; // Skip header
// 				const rowData = {};
// 				headers.forEach((header, i) => {
// 					//rowData[header] = row.getCell(i + 1).value;
// 					rowData[header] = String(row.getCell(i + 1).value ?? '');

// 				});
// 				data.push(rowData);
// 			});
// 			return data;
// 		}
// 	}

// 	/**
// 	 * Returns a list of all worksheet names in the given Excel file.
// 	 *
// 	 * @param {string} filePath - The full path to the Excel (.xlsx) file.
// 	 * @returns {Promise<string[]>} - An array of sheet names.
// 	 * @throws {Error} If the file cannot be read.
// 	 *
// 	 * @example
// 	 * const sheetNames = await ExcelHelper.getWorksheetNames('./data.xlsx');
// 	 * console.log(sheetNames); // ['Settings', 'location', 'vehicle']
// 	 */
// 	static async getWorksheetNames(filePath) {
// 		const workbook = new ExcelJS.Workbook();
// 		await workbook.xlsx.readFile(filePath);
// 		return workbook.worksheets.map(sheet => sheet.name);
// 	}
// }

// module.exports = ExcelHelper;