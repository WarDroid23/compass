/* eslint-disable no-var */
/* eslint-disable callback-return */
/* eslint-disable complexity */

/**
 * TODO: lucas: rename `export-formatters`
 */

import csv from 'fast-csv';
import { EJSON } from 'bson';
import { serialize as flatten } from './bson-csv';
import { Transform } from 'stream';
import { EOL } from 'os';

/**
 * @returns {Stream.Transform}
 */
export const createJSONFormatter = function({ brackets = true } = {}) {
  // if (brackets) {
  //   return JSONStream.stringify(open, sep, close);
  // }

  return new Transform({
    readableObjectMode: false,
    writableObjectMode: true,
    transform: function(doc, encoding, callback) {
      if (this._counter >= 1) {
        if (brackets) {
          this.push(',');
        } else {
          this.push(EOL);
        }
      }
      const s = EJSON.stringify(doc, null, brackets ? 2 : null);
      if (this._counter === undefined) {
        this._counter = 0;
        if (brackets) {
          this.push('[');
        }
      }
      callback(null, s);
      this._counter++;
    },
    final: function(done) {
      if (brackets) {
        this.push(']');
      }
      done();
    }
  });
};

/**
 * @returns {Stream.Transform}
 */
export const createCSVFormatter = function() {
  return csv.format({
    headers: true,
    transform: row => flatten(row)
  });
};
