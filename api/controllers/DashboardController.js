var pg = require('pg');
var when = require('when');
require('date-utils');

module.exports = {
  index: function(req, res) {
    if (req.query.date) {
      req.check('date', 'Field `date` is invalid').isDate();
    }

    var errors = req.validationErrors();
    var paramErrors = req.validationErrors(true);
    if (errors) {
      return res.badRequest(_.first(errors).msg, paramErrors);
    }

    var reports;
    var ILIThisWeek, ILILastWeek, ILIDelta;
    var numberOfReporters, numberOfReports;
    var topSymptoms;

    // Query parameters.
    var city = req.query.city;
    var currentDate = (new Date()).addDays(-7);
    var weekAgoDate = (new Date(currentDate)).addDays(-7);

    getReportSummary()
      // Get reports summary
      .then(function(result) {
        reports = result;
      })
      // Get ILI summary
      .then(function() {
        return getILI(city, currentDate)
          .then(function(result) {
            ILIThisWeek = result;
          })
          .then(function() {
            return getILI(city, weekAgoDate);
          })
          .then(function(result) {
            ILILastWeek = result;
            ILIDelta = ILIThisWeek - ILILastWeek;
          });
      })
      // Get report stat
      .then(function() {
        return getNumberOfReportersAndReports(city, currentDate)
          .then(function(result) {
            numberOfReporters = result.numberOfReporters;
            numberOfReports = result.numberOfReports;
          });
      })
      // Get top(popular) symptoms
      .then(function() {
        return getTopSymptoms(city, currentDate)
          .then(function(result) {
            topSymptoms = result.items;
          });
      })
      // Send error
      .catch(function(err) {
        if (err.statusCode == 404) {
          res.notFound(err);
        }
        else {
          res.serverError(err);
        }
      })
      // Clean up.
      .finally(function() {
        res.ok({
          reports: {
            count: reports.length,
            items: reports
          },
          ILI: {
            thisWeek: ILIThisWeek,
            lastWeek: ILILastWeek,
            delta: ILIDelta
          },
          numberOfReporters: numberOfReporters,
          numberOfReports: numberOfReports,
          graphs: {
            BOE: [ 0 ],
            Sicksense: [ 0 ]
          },
          topSymptoms: topSymptoms
        });
      });
  }
};


function getReportSummary() {
  return when.promise(function(resolve, reject) {
    var selectQuery = '\
      SELECT \
        r.district as district, \
        MAX(r."addressLatitude") as latitude, \
        MAX(r."addressLongitude") as longitude, \
        COUNT(CASE WHEN "isFine" THEN 1 ELSE NULL END) as finecount, \
        COUNT(CASE WHEN "isFine" THEN NULL ELSE 1 END) as sickcount, \
        COUNT(r.id) as total \
      FROM reports r \
      GROUP BY r.district \
    ';

    pg.connect(sails.config.connections.postgresql.connectionString, function(err, client, pgDone) {
      if (err) {
        sails.log.error(err);
        var error = new Error("Could not connect to database");
        error.statusCode = 500;
        return reject(err);
      }

      client.query(selectQuery, [], function(err, result) {
        pgDone();

        if (err) {
          sails.log.error(err);
          var error = new Error("Could not perform your request");
          error.statusCode = 500;
          return reject(err);
        }

        return resolve(result.rows);
      });
    });
  });
}

function getILI(city, currentDate) {
  return when.promise(function(resolve, reject) {
    currentDate = new Date(currentDate || null);
    // Get the first week day.
    var startDate = (new Date(currentDate)).addDays(-1 * currentDate.getDay()).clearTime();
    // .. and endDate = startDate + 7 days
    var endDate = (new Date(startDate)).addDays(7);

    var ILISymptoms = sails.config.symptoms.ILISymptoms;
    var values = [ startDate.toJSON(), endDate.toJSON() ];
    var params = [];
    var lastIndex = 0;

    _.each(ILISymptoms, function(value, index) {
      values.push(value);
      lastIndex = index + 3;
      params.push('$' + lastIndex); // So it will be [ 3, 4, 5, ... ]
    });

    var cityCriteria = '';
    if (city) {
      cityCriteria = ' AND r.city = $' + (lastIndex + 1) + ' ';
      values.push(city);
    }

    var selectQuery = '\
      SELECT COUNT(DISTINCT r."userId") as ilicount \
      FROM reports r \
        INNER JOIN reportssymptoms rs ON r.id = rs."reportId" \
        INNER JOIN symptoms s ON rs."symptomId" = s.id \
      WHERE r."createdAt" BETWEEN $1 AND $2 \
        AND s.name IN (' + params.join(', ') + ') ' + cityCriteria + ' \
    ';

    pg.connect(sails.config.connections.postgresql.connectionString, function(err, client, pgDone) {
      if (err) {
        sails.log.error(err);
        var error = new Error("Could not connect to database");
        error.statusCode = 500;
        return reject(err);
      }

      client.query(selectQuery, values, function(err, iliResult) {
        if (err) {
          sails.log.error('-- iliresult', err);
          var error = new Error("Could not perform your request");
          error.statusCode = 500;
          return reject(err);
        }

        var values = [ startDate.toJSON(), endDate.toJSON() ];
        if (city) {
          values.push(city);
          cityCriteria = ' AND r.city = $3 ';
        }

        // Count all reports for current week.
        client.query('\
          SELECT COUNT(DISTINCT r."userId") as total \
          FROM reports r \
          WHERE "createdAt" BETWEEN $1 AND $2 ' + cityCriteria + ' \
        ', values, function(err, totalResult) {
          pgDone();

          if (err) {
            sails.log.error('-- countili', err);
            var error = new Error("Could not perform your request");
            error.statusCode = 500;
            return reject(err);
          }

          return resolve(parseFloat(
            // Make it percent.
            (100.00 *
              (iliResult.rows[0].ilicount / totalResult.rows[0].total)
            )
            // Only 2 digits after the decimal place.
            .toFixed(2)
          ));
        });
      });
    });
  });
}

function getNumberOfReportersAndReports(city, currentDate) {
  return when.promise(function(resolve, reject) {
    currentDate = new Date(currentDate || null);
    // Get the first week day.
    var startDate = (new Date(currentDate)).addDays(-1 * currentDate.getDay()).clearTime();
    // .. and endDate = startDate + 7 days
    var endDate = (new Date(startDate)).addDays(7);

    pg.connect(sails.config.connections.postgresql.connectionString, function(err, client, pgDone) {
      if (err) {
        sails.log.error('-- report numbers', err);
        var error = new Error("Could not connect to database");
        error.statusCode = 500;
        return reject(err);
      }

      var values = [ startDate.toJSON(), endDate.toJSON() ];

      var cityCriteria = '';
      if (city) {
        cityCriteria = ' AND r.city = $3 ';
        values.push(city);
      }

      client.query(' \
        SELECT COUNT(*) as totalreports, COUNT(DISTINCT "userId") as totalreporters \
        FROM reports r \
        WHERE "createdAt" BETWEEN $1 AND $2 ' + cityCriteria + ' \
      ', values, function(err, result) {
        pgDone();

        if (err) {
          sails.log.error('-- count report numbers', err);
          var error = new Error("Could not perform your request");
          error.statusCode = 500;
          return reject(err);
        }

        return resolve({
          numberOfReporters: parseInt(result.rows[0].totalreporters),
          numberOfReports: parseInt(result.rows[0].totalreports)
        });
      });
    });
  });
}

function getTopSymptoms(city, currentDate) {
  return when.promise(function(resolve, reject) {
    currentDate = new Date(currentDate || null);
    // Get the first week day.
    var startDate = (new Date(currentDate)).addDays(-1 * currentDate.getDay()).clearTime();
    // .. and endDate = startDate + 7 days
    var endDate = (new Date(startDate)).addDays(7);

    pg.connect(sails.config.connections.postgresql.connectionString, function(err, client, pgDone) {
      if (err) {
        sails.log.error('-- get top symptoms', err);
        var error = new Error("Could not connect to database");
        error.statusCode = 500;
        return reject(err);
      }

      var values = [ startDate.toJSON(), endDate.toJSON() ];

      var cityCriteria = '';
      if (city) {
        cityCriteria = ' AND r.city = $3 ';
        values.push(city);
      }

      client.query('\
        SELECT s.name as name, COUNT(DISTINCT r."userId") as count \
        FROM reports r \
          INNER JOIN reportssymptoms rs ON r.id = rs."reportId" \
          INNER JOIN symptoms s ON rs."symptomId" = s.id \
        WHERE r."createdAt" BETWEEN $1 AND $2 ' + cityCriteria + ' \
        GROUP BY s.name \
        ORDER BY count DESC \
      ', values, function(err, selectResult) {

        if (err) {
          sails.log.error('-- get top symptoms', err);
          var error = new Error("Could not perform your request");
          error.statusCode = 500;
          return reject(err);
        }

        // Count all reports for current week.
        client.query('\
          SELECT COUNT(DISTINCT r."userId") as total \
          FROM reports r \
          WHERE r."createdAt" BETWEEN $1 AND $2 ' + cityCriteria + ' \
            AND r."isFine" IS FALSE \
        ', values, function(err, totalResult) {
          pgDone();

          if (err) {
            sails.log.error('-- get count symptoms', err);
            var error = new Error("Could not perform your request");
            error.statusCode = 500;
            return reject(err);
          }

          var total = parseInt(totalResult.rows[0].total);
          var topList = _.map(selectResult.rows, function(row) {
            return {
              name: row.name,
              numberOfReports: parseInt(row.count),
              percentOfReports: parseFloat(100 * (row.count / total).toFixed(2))
            };
          });

          return resolve({
            count: total,
            items: topList
          });

        });
      });
    });
  });
}
