/**
 * Copyright (c) 2010-2016 Brian Carlson (brian.m.carlson@gmail.com)
 * All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * README.md file in the root directory of this source tree.
 */

var EventEmitter = require('events').EventEmitter;
var util = require('util');

var Result = require('./result');
var utils = require('./utils');
var configGlobal;
var Query = function(config, values, callback) {
  // use of "new" optional
  if(!(this instanceof Query)) { return new Query(config, values, callback); }

  config = utils.normalizeQueryConfig(config, values, callback);

  this.text = config.text;
  this.values = config.values;
  this.rows = config.rows;
  this.types = config.types;
  this.name = config.name;
  this.binary = config.binary;
  this.stream = config.stream;
  //use unique portal name each time
  this.portal = config.portal || "";
  this.callback = config.callback;
  if(process.domain && config.callback) {
    this.callback = process.domain.bind(config.callback);
  }
  //this._result = new Result(config.rowMode, config.types);
  this._result = new Array();
  this.isPreparedStatement = false;
  this._canceledDueToError = false;
  this._promise = null;
  configGlobal = config;
  EventEmitter.call(this);
};

util.inherits(Query, EventEmitter);

Query.prototype.then = function(onSuccess, onFailure) {
  return this.promise().then(onSuccess, onFailure);
};

Query.prototype.catch = function(callback) {
  return this.promise().catch(callback);
};

Query.prototype.promise = function() {
  if (this._promise) return this._promise;
  this._promise = new Promise(function(resolve, reject) {
    this.once('end', resolve);
    this.once('error', reject);
  }.bind(this));
  return this._promise;
};

Query.prototype.requiresPreparation = function() {
  //named queries must always be prepared
  if(this.name) { return true; }
  //always prepare if there are max number of rows expected per
  //portal execution
  if(this.rows) { return true; }
  //don't prepare empty text queries
  if(!this.text) { return false; }
  //prepare if there are values
  if(!this.values) { return false; }
  return this.values.length > 0;
};


//associates row metadata from the supplied
//message with this query object
//metadata used when parsing row results
Query.prototype.handleRowDescription = function(msg) {
  //this._result.addFields(msg.fields);
  this._accumulateRows = this.callback || !this.listeners('row').length;
  this.currentResult = new Result(configGlobal.rowMode, configGlobal.types);
  this.currentResult.completed = false;
  this.currentResult.addFields(msg.fields);
};

Query.prototype.handleDataRow = function(msg) {
  var row = this.currentResult.parseRow(msg.fields);
  this.emit('row', row, this.currentResult);
  if (this._accumulateRows) {
    this.currentResult.addRow(row);
  }
};

Query.prototype.handleCommandComplete = function(msg, con) {
  if(this.currentResult == null || this.currentResult.completed == true){
      this.currentResult = new Result(configGlobal.rowMode, configGlobal.types);
    }
  this.currentResult.addCommandComplete(msg);
  this._result.push(this.currentResult);
  this.currentResult.completed = true;
  //need to sync after each command complete of a prepared statement
  if(this.isPreparedStatement) {
    con.sync();
  }
};

//if a named prepared statement is created with empty query text
//the backend will send an emptyQuery message but *not* a command complete message
//execution on the connection will hang until the backend receives a sync message
Query.prototype.handleEmptyQuery = function(con) {
  if (this.isPreparedStatement) {
    con.sync();
  }
};

Query.prototype.handleReadyForQuery = function(con) {
  if(this._canceledDueToError) {
    return this.handleError(this._canceledDueToError, con);
  }
  if(this.callback) {
    this.callback(null, this._result);
  }
  this.emit('end', this._result);
};

Query.prototype.handleError = function(err, connection) {
  //need to sync after error during a prepared statement
  if(this.isPreparedStatement) {
    connection.sync();
  }
  if(this._canceledDueToError) {
    err = this._canceledDueToError;
    this._canceledDueToError = false;
  }
  //if callback supplied do not emit error event as uncaught error
  //events will bubble up to node process
  if(this.callback) {
    return this.callback(err);
  }
  this.emit('error', err);
};

Query.prototype.submit = function(connection) {
  if(this.requiresPreparation()) {
    this.prepare(connection);
  } else {
    connection.query(this.text);
  }
};

Query.prototype.hasBeenParsed = function(connection) {
  return this.name && connection.parsedStatements[this.name];
};

Query.prototype.handlePortalSuspended = function(connection) {
  this._getRows(connection, this.rows);
};

Query.prototype._getRows = function(connection, rows) {
  connection.execute({
    portal: this.portal,
    rows: rows
  }, true);
  connection.flush();
};

Query.prototype.prepare = function(connection) {
  var self = this;
  //prepared statements need sync to be called after each command
  //complete or when an error is encountered
  this.isPreparedStatement = true;
  //TODO refactor this poor encapsulation
  if(!this.hasBeenParsed(connection)) {
    connection.parse({
      text: self.text,
      name: self.name,
      types: self.types
    }, true);
  }

  if(self.values) {
    self.values = self.values.map(utils.prepareValue);
  }

  //http://developer.postgresql.org/pgdocs/postgres/protocol-flow.html#PROTOCOL-FLOW-EXT-QUERY
  connection.bind({
    portal: self.portal,
    statement: self.name,
    values: self.values,
    binary: self.binary
  }, true);

  connection.describe({
    type: 'P',
    name: self.portal || ''
  }, true)

  this._getRows(connection, this.rows);
};

Query.prototype.handleCopyInResponse = function (connection) {
  if(this.stream) this.stream.startStreamingToConnection(connection);
  else connection.sendCopyFail('No source stream defined');
};

Query.prototype.handleCopyData = function (msg, connection) {
  var chunk = msg.chunk;
  if(this.stream) {
    this.stream.handleChunk(chunk);
  }
  //if there are no stream (for example when copy to query was sent by
  //query method instead of copyTo) error will be handled
  //on copyOutResponse event, so silently ignore this error here
};
module.exports = Query;
